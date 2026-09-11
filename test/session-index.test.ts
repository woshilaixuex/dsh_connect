import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { migrate, type Migration } from '../src/store/store.js'
import { openSessionIndex, createMemorySessionIndex, type SessionIndex } from '../src/sessions/session-index.js'

let dirs: string[] = []
let dbs: DatabaseSync[] = []

beforeEach(() => {
  dirs = []
  dbs = []
})

afterEach(() => {
  for (const db of dbs) {
    try {
      db.close()
    } catch {
      /* 已关闭 */
    }
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function newDb(): DatabaseSync {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-connect-session-idx-'))
  dirs.push(dir)
  const db = new DatabaseSync(join(dir, 'index.db'))
  dbs.push(db)
  return db
}

describe('migrate', () => {
  test('全新库跑到最新版本;版本记录在 meta', () => {
    const db = newDb()
    const version = migrate(db, [
      { version: 1, up: (d) => d.exec('CREATE TABLE a (x INTEGER)') },
      { version: 2, up: (d) => d.exec('CREATE TABLE b (y INTEGER)') },
    ])
    assert.equal(version, 2)
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }
    assert.equal(row.value, '2')
  })

  test('重复执行幂等:已应用的迁移不再跑', () => {
    const db = newDb()
    let runs = 0
    const migrations: Migration[] = [
      {
        version: 1,
        up: (d) => {
          runs++
          d.exec('CREATE TABLE a (x INTEGER)')
        },
      },
    ]
    migrate(db, migrations)
    migrate(db, migrations)
    assert.equal(runs, 1)
  })

  test('只应用高于当前版本的迁移', () => {
    const db = newDb()
    const applied: number[] = []
    migrate(db, [{ version: 1, up: () => applied.push(1) }])
    migrate(db, [
      { version: 1, up: () => applied.push(1) },
      { version: 2, up: () => applied.push(2) },
    ])
    assert.deepEqual(applied, [1, 2])
  })

  test('迁移失败回滚且不记录版本', () => {
    const db = newDb()
    assert.throws(() =>
      migrate(db, [
        { version: 1, up: (d) => d.exec('CREATE TABLE a (x INTEGER)') },
        {
          version: 2,
          up: () => {
            throw new Error('boom')
          },
        },
      ]),
    )
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }
    assert.equal(row.value, '1')
  })
})

/** 对两种实现跑同一组行为断言。 */
function runIndexSuite(name: string, make: () => SessionIndex) {
  describe(`SessionIndex: ${name}`, () => {
    let index: SessionIndex
    beforeEach(() => {
      index = make()
    })

    test('upsert 新会话并回读', () => {
      const summary = index.upsert('sess-1', { title: '第一个会话', now: 1000 })
      assert.equal(summary.sessionId, 'sess-1')
      assert.equal(summary.title, '第一个会话')
      assert.equal(summary.createdAt, 1000)
      assert.equal(summary.messageCount, 0)
      assert.deepEqual(index.get('sess-1'), summary)
    })

    test('upsert 已存在时保留 created_at,刷新 last_active_at', () => {
      index.upsert('sess-1', { now: 1000 })
      const again = index.upsert('sess-1', { now: 2000 })
      assert.equal(again.createdAt, 1000)
      assert.equal(again.lastActiveAt, 2000)
    })

    test('get 未登记会话返回 undefined', () => {
      assert.equal(index.get('nope'), undefined)
    })

    test('list 按 last_active_at 倒序', () => {
      index.upsert('a', { now: 1000 })
      index.upsert('b', { now: 3000 })
      index.upsert('c', { now: 2000 })
      assert.deepEqual(
        index.list().map((s) => s.sessionId),
        ['b', 'c', 'a'],
      )
    })

    test('list 支持 limit/offset', () => {
      index.upsert('a', { now: 1000 })
      index.upsert('b', { now: 3000 })
      index.upsert('c', { now: 2000 })
      assert.deepEqual(index.list({ limit: 2 }).map((s) => s.sessionId), ['b', 'c'])
      assert.deepEqual(index.list({ limit: 2, offset: 2 }).map((s) => s.sessionId), ['a'])
    })

    test('touch 累加消息计数并更新预览', () => {
      index.upsert('sess-1')
      index.touch('sess-1', { lastMessage: '你好', messageDelta: 2 })
      const summary = index.get('sess-1')!
      assert.equal(summary.lastMessage, '你好')
      assert.equal(summary.messageCount, 2)
    })

    test('软删后默认列表不含,includeDeleted 可见', () => {
      index.upsert('sess-1')
      assert.equal(index.softDelete('sess-1'), true)
      assert.deepEqual(index.list(), [])
      assert.deepEqual(index.list({ includeDeleted: true }).map((s) => s.sessionId), ['sess-1'])
      assert.equal(index.get('sess-1')!.deleted, true)
    })

    test('软删幂等:第二次返回 false', () => {
      index.upsert('sess-1')
      assert.equal(index.softDelete('sess-1'), true)
      assert.equal(index.softDelete('sess-1'), false)
    })

    test('upsert 已软删会话会复活', () => {
      index.upsert('sess-1')
      index.softDelete('sess-1')
      index.upsert('sess-1')
      assert.equal(index.get('sess-1')!.deleted, undefined)
      assert.equal(index.has('sess-1'), true)
    })

    test('has 反映存在且未软删', () => {
      assert.equal(index.has('sess-1'), false)
      index.upsert('sess-1')
      assert.equal(index.has('sess-1'), true)
      index.softDelete('sess-1')
      assert.equal(index.has('sess-1'), false)
    })
  })
}

runIndexSuite('SQLite', () => openSessionIndex(newDb()))
runIndexSuite('内存', () => createMemorySessionIndex())

describe('索引对象被解构后仍可用(无 this 依赖)', () => {
  test('SQLite 实现', () => {
    const index = openSessionIndex(newDb())
    const { upsert, get } = index
    upsert('sess-x', { title: 't' })
    assert.equal(get('sess-x')!.title, 't')
  })

  test('内存实现', () => {
    const index = createMemorySessionIndex()
    const { upsert, get } = index
    upsert('sess-x', { title: 't' })
    assert.equal(get('sess-x')!.title, 't')
  })
})

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, resolveDbPath, type StoreCtx } from '../src/store/store.js'

let dirs: string[] = []

beforeEach(() => {
  dirs = []
})

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-connect-store-'))
  dirs.push(dir)
  return dir
}

function makeCtx(home?: string): StoreCtx {
  const base = home ?? join(tmpdir(), 'fake-dsh-home')
  return {
    get: (key: string) => (key === 'dshHomePath' ? (...seg: string[]) => join(base, ...seg) : undefined),
  } as StoreCtx
}

describe('resolveDbPath', () => {
  test('dbPath 缺省 → dsh home 下的默认文件', () => {
    const home = makeTempDir()
    const ctx = makeCtx(home)
    assert.equal(resolveDbPath(ctx, undefined), join(home, 'dsh-connect', 'dsh-connect.db'))
  })

  test('dbPath 空串 → undefined(不启用)', () => {
    const home = makeTempDir()
    assert.equal(resolveDbPath(makeCtx(home), ''), undefined)
  })

  test('相对路径基于 dsh home 解析', () => {
    const home = makeTempDir()
    assert.equal(resolveDbPath(makeCtx(home), 'var/data.db'), join(home, 'var', 'data.db'))
  })

  test('绝对路径原样返回', () => {
    const file = join(makeTempDir(), 'custom.db')
    assert.equal(resolveDbPath(makeCtx(), file), file)
  })

  test('dshHomePath 不可用时回退 os.homedir()/.dsh', () => {
    const ctx = { get: () => undefined } as StoreCtx
    const resolved = resolveDbPath(ctx, undefined)
    assert.ok(resolved?.endsWith(join('.dsh', 'dsh-connect', 'dsh-connect.db')))
  })
})

describe('openDatabase', () => {
  test('自动建目录并生成数据库文件', () => {
    const dir = makeTempDir()
    const file = join(dir, 'data', 't.db')
    const handle = openDatabase(makeCtx(), file)
    assert.ok(existsSync(file))
    handle.dispose()
  })

  test('基础 PRAGMA 生效:WAL + 外键 + busy_timeout', () => {
    const file = join(makeTempDir(), 't.db')
    const handle = openDatabase(makeCtx(), file)
    const journal = handle.db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }
    assert.equal(journal.journal_mode, 'wal')
    const fk = handle.db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }
    assert.equal(fk.foreign_keys, 1)
    handle.dispose()
  })

  test('建表/写入/读取回环', () => {
    const file = join(makeTempDir(), 't.db')
    const handle = openDatabase(makeCtx(), file)
    handle.db.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)')
    handle.db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run('a', '1')
    const row = handle.db.prepare('SELECT v FROM kv WHERE k = ?').get('a') as { v: string }
    assert.equal(row.v, '1')
    handle.dispose()
  })

  test('dispose 幂等;关闭后再查询抛错', () => {
    const file = join(makeTempDir(), 't.db')
    const handle = openDatabase(makeCtx(), file)
    handle.db.exec('CREATE TABLE t (x INTEGER)')
    handle.dispose()
    handle.dispose() // 不抛
    assert.throws(() => handle.db.prepare('SELECT 1').get())
  })

  test('数据落盘:关闭后重开可读回', () => {
    const file = join(makeTempDir(), 't.db')
    const first = openDatabase(makeCtx(), file)
    first.db.exec('CREATE TABLE t (x TEXT)')
    first.db.prepare('INSERT INTO t (x) VALUES (?)').run('persisted')
    first.dispose()

    const second = openDatabase(makeCtx(), file)
    const row = second.db.prepare('SELECT x FROM t').get() as { x: string }
    assert.equal(row.x, 'persisted')
    second.dispose()
  })
})

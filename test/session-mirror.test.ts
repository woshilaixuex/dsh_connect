import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  mergeSessionRows,
  listSessionRows,
  type HostSessionRecord,
} from '../src/sessions/session-mirror.js'
import { createMemorySessionIndex, type SessionIndex } from '../src/sessions/session-index.js'
import { makeLogger } from './helpers.js'

function host(id: string, opts: { cwd?: string; createdAt?: number; live?: boolean } = {}): HostSessionRecord {
  return {
    header: {
      id,
      createdAt: opts.createdAt ?? 1000,
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
    },
    live: opts.live ?? false,
    persisted: true,
  }
}

describe('mergeSessionRows', () => {
  test('宿主会话默认标记 source=host', () => {
    const rows = mergeSessionRows([host('h1')], new Map(), [])
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.source, 'host')
    assert.equal(rows[0]!.sessionId, 'h1')
  })

  test('索引里的会话覆盖 source(客户端会话标 client)', () => {
    const index = createMemorySessionIndex()
    index.upsert('client-1', { source: 'client' })
    const rows = mergeSessionRows([], new Map(), index.listAll())
    assert.equal(rows[0]!.source, 'client')
  })

  test('宿主会话被索引登记后 source 取索引值', () => {
    const index = createMemorySessionIndex()
    index.upsert('h1', { source: 'host' })
    const rows = mergeSessionRows([host('h1')], new Map(), index.listAll())
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.source, 'host')
    assert.equal(rows[0]!.persisted, true)
  })

  test('标题:索引优先于宿主', () => {
    const index = createMemorySessionIndex()
    index.upsert('h1', { source: 'host', title: '客户端标题' })
    const titles = new Map([['h1', '宿主标题']])
    const rows = mergeSessionRows([host('h1')], titles, index.listAll())
    assert.equal(rows[0]!.title, '客户端标题')
  })

  test('标题:索引没有时用宿主标题', () => {
    const rows = mergeSessionRows([host('h1')], new Map([['h1', '宿主标题']]), [])
    assert.equal(rows[0]!.title, '宿主标题')
  })

  test('cwd 来自宿主 header', () => {
    const rows = mergeSessionRows([host('h1', { cwd: 'D:/proj' })], new Map(), [])
    assert.equal(rows[0]!.cwd, 'D:/proj')
  })

  test('updatedAt 取索引活跃时间与宿主创建时间的较大者', () => {
    const index = createMemorySessionIndex()
    index.upsert('h1', { source: 'host', now: 5000 })
    const rows = mergeSessionRows([host('h1', { createdAt: 1000 })], new Map(), index.listAll())
    assert.equal(rows[0]!.updatedAt, 5000)

    const index2 = createMemorySessionIndex()
    index2.upsert('h2', { source: 'host', now: 500 })
    const rows2 = mergeSessionRows([host('h2', { createdAt: 9000 })], new Map(), index2.listAll())
    assert.equal(rows2[0]!.updatedAt, 9000)
  })

  test('按 updatedAt 倒序', () => {
    const index = createMemorySessionIndex()
    index.upsert('a', { source: 'client', now: 1000 })
    index.upsert('b', { source: 'client', now: 3000 })
    index.upsert('c', { source: 'client', now: 2000 })
    const rows = mergeSessionRows([], new Map(), index.listAll())
    assert.deepEqual(rows.map((r) => r.sessionId), ['b', 'c', 'a'])
  })
})

describe('listSessionRows', () => {
  function deps(init: {
    hosts?: HostSessionRecord[]
    titles?: Map<string, string>
    index?: SessionIndex
    listThrows?: boolean
    titlesThrow?: boolean
  }) {
    const index = init.index ?? createMemorySessionIndex()
    return {
      deps: {
        listHostSessions: async () => {
          if (init.listThrows) throw new Error('host listing exploded')
          return init.hosts ?? []
        },
        readTitles: async () => {
          if (init.titlesThrow) throw new Error('title read exploded')
          return init.titles ?? new Map<string, string>()
        },
        index,
        logger: makeLogger(),
      },
      index,
    }
  }

  test('合并宿主与索引,并按 source 分流', async () => {
    const index = createMemorySessionIndex()
    index.upsert('client-1', { source: 'client' })
    const { deps: d } = deps({ hosts: [host('h1')], index })
    const { rows, hostCount, indexCount } = await listSessionRows(d)
    assert.equal(hostCount, 1)
    assert.equal(indexCount, 1)
    assert.deepEqual(rows.map((r) => r.sessionId).sort(), ['client-1', 'h1'])
    assert.equal(rows.find((r) => r.sessionId === 'client-1')!.source, 'client')
    assert.equal(rows.find((r) => r.sessionId === 'h1')!.source, 'host')
  })

  test('默认过滤软删;includeDeleted 可见', async () => {
    const index = createMemorySessionIndex()
    index.upsert('client-1', { source: 'client' })
    index.softDelete('client-1')
    const { deps: d } = deps({ index })

    const hidden = await listSessionRows(d)
    assert.deepEqual(hidden.rows, [])

    const shown = await listSessionRows(d, { includeDeleted: true })
    assert.equal(shown.rows.length, 1)
    assert.equal(shown.rows[0]!.deleted, true)
  })

  test('limit/offset 作用于合并后结果', async () => {
    const index = createMemorySessionIndex()
    index.upsert('a', { source: 'client', now: 1000 })
    index.upsert('b', { source: 'client', now: 3000 })
    index.upsert('c', { source: 'client', now: 2000 })
    const { deps: d } = deps({ index })
    const page = await listSessionRows(d, { limit: 2, offset: 1 })
    assert.deepEqual(page.rows.map((r) => r.sessionId), ['c', 'a'])
  })

  test('sessionId 过滤(供 session.get)', async () => {
    const index = createMemorySessionIndex()
    index.upsert('a', { source: 'client' })
    index.upsert('b', { source: 'client' })
    const { deps: d } = deps({ index })
    const one = await listSessionRows(d, { sessionId: 'b' })
    assert.equal(one.rows.length, 1)
    assert.equal(one.rows[0]!.sessionId, 'b')
  })

  test('宿主 listing 失败时降级为只用索引(不整体失败)', async () => {
    const index = createMemorySessionIndex()
    index.upsert('client-1', { source: 'client' })
    const { deps: d } = deps({ index, listThrows: true })
    const { rows, hostCount } = await listSessionRows(d)
    assert.equal(hostCount, 0)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.sessionId, 'client-1')
  })

  test('标题读取失败不影响列表', async () => {
    const index = createMemorySessionIndex()
    const { deps: d } = deps({ hosts: [host('h1')], index, titlesThrow: true })
    const { rows } = await listSessionRows(d)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.title, undefined)
  })
})

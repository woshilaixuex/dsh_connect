import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHandler, type RouteDeps } from '../src/http/routes.js'
import { createMemorySessionIndex, type SessionIndex } from '../src/sessions/session-index.js'
import type { HostSessionReader } from '../src/sessions/host-sessions.js'
import type { SessionRegistry, WireMessage } from '../src/sessions/session-registry.js'
import type { HostSessionRecord } from '../src/sessions/session-mirror.js'
import type { HostCtx } from '../src/bridge/agent-bridge.js'
import { makeLogger } from './helpers.js'

function hostRecord(id: string, opts: { cwd?: string; createdAt?: number } = {}): HostSessionRecord {
  return {
    header: { id, createdAt: opts.createdAt ?? 1000, ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }) },
    live: false,
    persisted: true,
  }
}

function makeDeps(init: {
  hostSessions?: HostSessionRecord[]
  titles?: Map<string, string>
  index?: SessionIndex
  registry?: Partial<SessionRegistry>
  workspaceRegistry?: unknown
} = {}) {
  const index = init.index ?? createMemorySessionIndex()
  const hostSessions = init.hostSessions ?? []
  const titles = init.titles ?? new Map<string, string>()

  const hostReader: HostSessionReader = {
    async list() {
      return hostSessions
    },
    async titles() {
      return titles
    },
    async exists() {
      return false
    },
  }

  const host: HostCtx = {
    get: (key: string) => (key === 'workspaceRegistry' ? init.workspaceRegistry : undefined),
    on: () => {},
    off: () => {},
  }

  const deps: RouteDeps = {
    host,
    hostReader,
    sessionIndex: index,
    ...(init.registry === undefined ? {} : { registry: init.registry as SessionRegistry }),
    logger: makeLogger(),
    startedAt: Date.now() - 1234,
  }
  return { deps, index }
}

function get(path: string, query: Record<string, string> = {}) {
  return { method: 'GET', path, query: new URLSearchParams(query) }
}

describe('GET /health', () => {
  test('返回 ok + 概览', async () => {
    const { deps, index } = makeDeps({ hostSessions: [hostRecord('h1')] })
    index.upsert('client-1', { source: 'client' })
    const handler = createHandler(deps)
    const res = await handler(get('/health'))
    assert.equal(res.status, 200)
    const body = res.body as {
      ok: boolean
      uptimeMs: number
      sessions: { host: number; index: number; live: number }
      workspaces: { source: string; count: number }
    }
    assert.equal(body.ok, true)
    assert.ok(body.uptimeMs >= 1234)
    assert.equal(body.sessions.host, 1)
    assert.equal(body.sessions.index, 1)
    assert.equal(body.sessions.live, 0)
    assert.equal(body.workspaces.source, 'cwd')
  })

  test('宿主 listing 抛错时仍返回 ok(降级)', async () => {
    const { deps } = makeDeps()
    deps.hostReader.list = async () => {
      throw new Error('boom')
    }
    const res = await createHandler(deps)(get('/health'))
    assert.equal(res.status, 200)
    assert.equal((res.body as { ok: boolean }).ok, true)
  })
})

describe('GET /sessions', () => {
  test('返回宿主 ∪ 索引,含来源', async () => {
    const index = createMemorySessionIndex()
    index.upsert('client-1', { source: 'client' })
    const { deps } = makeDeps({ hostSessions: [hostRecord('h1')], index })
    const res = await createHandler(deps)(get('/sessions'))
    assert.equal(res.status, 200)
    const body = res.body as { sessions: { sessionId: string; source: string }[]; meta: { hostCount: number } }
    assert.deepEqual(body.sessions.map((s) => s.sessionId).sort(), ['client-1', 'h1'])
    assert.equal(body.sessions.find((s) => s.sessionId === 'h1')!.source, 'host')
    assert.equal(body.meta.hostCount, 1)
  })

  test('limit/offset 生效', async () => {
    const index = createMemorySessionIndex()
    index.upsert('a', { source: 'client', now: 1000 })
    index.upsert('b', { source: 'client', now: 3000 })
    index.upsert('c', { source: 'client', now: 2000 })
    const { deps } = makeDeps({ index })
    const res = await createHandler(deps)(get('/sessions', { limit: '2', offset: '1' }))
    const body = res.body as { sessions: { sessionId: string }[] }
    assert.deepEqual(body.sessions.map((s) => s.sessionId), ['c', 'a'])
  })

  test('limit 非法 → 400', async () => {
    const { deps } = makeDeps()
    const res = await createHandler(deps)(get('/sessions', { limit: '-3' }))
    assert.equal(res.status, 400)
    assert.equal((res.body as { code: string }).code, 'bad.request')
  })

  test('默认过滤软删;includeDeleted=1 可见', async () => {
    const index = createMemorySessionIndex()
    index.upsert('client-1', { source: 'client' })
    index.softDelete('client-1')
    const { deps } = makeDeps({ index })

    const hidden = await createHandler(deps)(get('/sessions'))
    assert.deepEqual((hidden.body as { sessions: unknown[] }).sessions, [])

    const shown = await createHandler(deps)(get('/sessions', { includeDeleted: '1' }))
    assert.equal((shown.body as { sessions: unknown[] }).sessions.length, 1)
  })

  test('limit 超上限被夹到 MAX_LIMIT', async () => {
    const { deps } = makeDeps()
    const res = await createHandler(deps)(get('/sessions', { limit: '99999' }))
    assert.equal((res.body as { meta: { limit: number } }).meta.limit, 1000)
  })
})

describe('GET /workspaces', () => {
  test('registry 可用时用它', async () => {
    const registry = { list: () => [{ id: 'ws-1', path: 'D:/p', title: '项目', sessionIds: ['h1'] }] }
    const { deps } = makeDeps({ hostSessions: [hostRecord('h1', { cwd: 'D:/p' })], workspaceRegistry: registry })
    const res = await createHandler(deps)(get('/workspaces'))
    assert.equal(res.status, 200)
    const body = res.body as { source: string; workspaces: { workspaceId: string }[] }
    assert.equal(body.source, 'registry')
    assert.equal(body.workspaces[0]!.workspaceId, 'ws-1')
  })

  test('registry 缺失时按 cwd 兜底', async () => {
    const { deps } = makeDeps({
      hostSessions: [hostRecord('h1', { cwd: 'D:/a/p1' }), hostRecord('h2', { cwd: 'D:/a/p1' })],
    })
    const res = await createHandler(deps)(get('/workspaces'))
    const body = res.body as { source: string; workspaces: { path: string; sessionIds: string[] }[] }
    assert.equal(body.source, 'cwd')
    assert.equal(body.workspaces.length, 1)
    assert.deepEqual(body.workspaces[0]!.sessionIds.sort(), ['h1', 'h2'])
  })

  test('cwd 兜底模式下:软删会话后该 cwd 不再成为工作区', async () => {
    const index = createMemorySessionIndex()
    index.upsert('h1', { source: 'host' })
    index.softDelete('h1')
    const { deps } = makeDeps({ hostSessions: [hostRecord('h1', { cwd: 'D:/p' })], index })
    const res = await createHandler(deps)(get('/workspaces'))
    const body = res.body as { source: string; workspaces: unknown[] }
    // cwd 分组完全由可见会话派生:会话被软删 → 该 cwd 没有成员 → 不出现
    assert.equal(body.source, 'cwd')
    assert.deepEqual(body.workspaces, [])
  })

  test('registry 模式下软删会话只是移出成员(工作区仍在)', async () => {
    const index = createMemorySessionIndex()
    index.upsert('h1', { source: 'host' })
    index.softDelete('h1')
    const registry = { list: () => [{ id: 'ws-1', path: 'D:/p', title: '项目', sessionIds: ['h1'] }] }
    const { deps } = makeDeps({ hostSessions: [hostRecord('h1', { cwd: 'D:/p' })], index, workspaceRegistry: registry })
    const res = await createHandler(deps)(get('/workspaces'))
    const body = res.body as { source: string; workspaces: { workspaceId: string; sessionIds: string[] }[] }
    assert.equal(body.source, 'registry')
    assert.equal(body.workspaces.length, 1)
    assert.deepEqual(body.workspaces[0]!.sessionIds, [])
  })
})

describe('GET /sessions/:id/history', () => {
  test('活跃会话用内存历史', async () => {
    const messages: WireMessage[] = [
      { role: 'user', text: '你好', ts: 1 },
      { role: 'assistant', text: '收到', ts: 2 },
    ]
    const { deps } = makeDeps({ registry: { history: () => messages, liveIds: () => ['s1'] } })
    const res = await createHandler(deps)(get('/sessions/s1/history'))
    assert.equal(res.status, 200)
    const body = res.body as { sessionId: string; source: string; messages: WireMessage[] }
    assert.equal(body.sessionId, 's1')
    assert.equal(body.source, 'memory')
    assert.deepEqual(body.messages, messages)
  })

  test('未激活会话回退宿主持久化', async () => {
    const { deps } = makeDeps({ registry: { history: () => undefined, liveIds: () => [] } })
    deps.host.get = (key: string) =>
      key === 'sessionQuery'
        ? {
            readSession: async () => ({
              events: [
                { type: 'user/message', time: 10, data: { content: [{ type: 'text', text: '问' }] } },
                { type: 'assistant/message', time: 11, data: { message: { content: [{ type: 'text', text: '答' }] } } },
              ],
            }),
          }
        : undefined
    const res = await createHandler(deps)(get('/sessions/s2/history'))
    const body = res.body as { source: string; messages: { role: string; text: string }[] }
    assert.equal(body.source, 'persisted')
    assert.deepEqual(
      body.messages.map((m) => [m.role, m.text]),
      [
        ['user', '问'],
        ['assistant', '答'],
      ],
    )
  })

  test('limit 生效(取最近 N 条)', async () => {
    const messages: WireMessage[] = [
      { role: 'user', text: 'a', ts: 1 },
      { role: 'user', text: 'b', ts: 2 },
      { role: 'user', text: 'c', ts: 3 },
    ]
    const { deps } = makeDeps({ registry: { history: () => messages, liveIds: () => [] } })
    const res = await createHandler(deps)(get('/sessions/s1/history', { limit: '2' }))
    const body = res.body as { messages: { text: string }[] }
    assert.deepEqual(body.messages.map((m) => m.text), ['b', 'c'])
  })

  test('无 registry(无宿主 agent 服务)也能工作', async () => {
    const { deps } = makeDeps()
    const res = await createHandler(deps)(get('/sessions/s1/history'))
    assert.equal(res.status, 200)
    assert.deepEqual((res.body as { messages: unknown[] }).messages, [])
  })

  test('路径中的 id 会被 decode', async () => {
    const { deps } = makeDeps({ registry: { history: () => [], liveIds: () => [] } })
    const res = await createHandler(deps)(get('/sessions/sess%2D1/history'))
    assert.equal(res.status, 200)
    assert.equal((res.body as { sessionId: string }).sessionId, 'sess-1')
  })
})

describe('路由 / 方法 / 错误', () => {
  test('未知路径 → 404', async () => {
    const { deps } = makeDeps()
    const res = await createHandler(deps)(get('/nope'))
    assert.equal(res.status, 404)
    assert.equal((res.body as { code: string }).code, 'not.found')
  })

  test('非 GET/HEAD → 405', async () => {
    const { deps } = makeDeps()
    const handler = createHandler(deps)
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = await handler({ method, path: '/sessions', query: new URLSearchParams() })
      assert.equal(res.status, 405, `${method} should be rejected`)
      assert.equal((res.body as { code: string }).code, 'method.not.allowed')
    }
  })

  test('HEAD 放行(与 GET 同逻辑)', async () => {
    const { deps } = makeDeps()
    const res = await createHandler(deps)({ method: 'HEAD', path: '/health', query: new URLSearchParams() })
    assert.equal(res.status, 200)
  })

  test('handler 抛错 → 500(不外泄堆栈)', async () => {
    const { deps } = makeDeps()
    deps.hostReader.list = async () => {
      throw new Error('secret internal detail')
    }
    deps.sessionIndex.listAll = () => {
      throw new Error('secret internal detail')
    }
    const res = await createHandler(deps)(get('/health'))
    // /health 内部捕获了,所以这里仍是 200;换 /sessions 验证 500 路径
    assert.equal(res.status, 200)

    const { deps: deps2 } = makeDeps()
    deps2.hostReader.list = async () => {
      throw new Error('x')
    }
    deps2.sessionIndex.listAll = () => {
      throw new Error('boom')
    }
    const res2 = await createHandler(deps2)(get('/sessions'))
    assert.equal(res2.status, 500)
    assert.equal((res2.body as { code: string }).code, 'internal')
  })

  test('尾斜杠可容忍(/sessions/)', async () => {
    const { deps } = makeDeps()
    const res = await createHandler(deps)(get('/sessions/'))
    assert.equal(res.status, 200)
  })
})

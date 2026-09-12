import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from '../src/config/config.js'
import { LogLevel } from '../src/log/logger.js'
import { createHttpServer, type HttpServerHandle } from '../src/http/http-server.js'
import { createMemorySessionIndex, type SessionIndex } from '../src/sessions/session-index.js'
import type { HostSessionReader } from '../src/sessions/host-sessions.js'
import type { HostSessionRecord } from '../src/sessions/session-mirror.js'
import type { HostCtx } from '../src/bridge/agent-bridge.js'
import { makeLogger } from './helpers.js'

function fakeCtx(): Context {
  return { logger: () => makeLogger(), get: () => undefined, on() {}, off() {} } as unknown as Context
}

function hostRecord(id: string, cwd?: string): HostSessionRecord {
  return {
    header: { id, createdAt: 1000, ...(cwd === undefined ? {} : { cwd }) },
    live: false,
    persisted: true,
  }
}

let server: HttpServerHandle
let baseUrl = ''
let index: SessionIndex

beforeEach(async () => {
  index = createMemorySessionIndex()
  index.upsert('client-1', { source: 'client', title: '客户端会话' })

  const hostSessions = [hostRecord('h1', 'D:/proj'), hostRecord('h2')]
  const hostReader: HostSessionReader = {
    async list() {
      return hostSessions
    },
    async titles() {
      return new Map([['h1', '宿主会话']])
    },
    async exists() {
      return false
    },
  }
  const host: HostCtx = { get: () => undefined, on() {}, off() {} }

  const config: Config = {
    hostName: '127.0.0.1',
    listenPort: 0,
    httpPort: 0, // 随机端口
    logLevel: LogLevel.DEV,
    sessionIdleTimeoutMs: 60_000,
  }
  server = createHttpServer(fakeCtx(), config, { host, hostReader, sessionIndex: index })
  const port = await server.port
  baseUrl = `http://127.0.0.1:${port}`
})

afterEach(async () => {
  await server?.dispose()
})

async function getJson(path: string): Promise<{ status: number; body: unknown; headers: Headers }> {
  const res = await fetch(`${baseUrl}${path}`)
  const body = await res.json()
  return { status: res.status, body, headers: res.headers }
}

describe('HTTP server(真实请求)', () => {
  test('GET /health → 200 + ok', async () => {
    const { status, body } = await getJson('/health')
    assert.equal(status, 200)
    const parsed = body as { ok: boolean; sessions: { host: number; index: number } }
    assert.equal(parsed.ok, true)
    assert.equal(parsed.sessions.host, 2)
    assert.equal(parsed.sessions.index, 1)
  })

  test('GET /sessions → 宿主 ∪ 索引', async () => {
    const { status, body } = await getJson('/sessions')
    assert.equal(status, 200)
    const sessions = (body as { sessions: { sessionId: string; source: string; title?: string }[] }).sessions
    assert.equal(sessions.length, 3)
    assert.equal(sessions.find((s) => s.sessionId === 'h1')!.source, 'host')
    assert.equal(sessions.find((s) => s.sessionId === 'h1')!.title, '宿主会话') // 宿主标题
    assert.equal(sessions.find((s) => s.sessionId === 'client-1')!.source, 'client')
  })

  test('GET /workspaces → cwd 兜底', async () => {
    const { status, body } = await getJson('/workspaces')
    assert.equal(status, 200)
    const parsed = body as { source: string; workspaces: { path: string; sessionIds: string[] }[] }
    assert.equal(parsed.source, 'cwd')
    assert.equal(parsed.workspaces.length, 1)
    assert.equal(parsed.workspaces[0]!.path, 'D:/proj')
  })

  test('GET /sessions/:id/history → 200(无 registry 时回退持久化,空历史)', async () => {
    const { status, body } = await getJson('/sessions/h1/history')
    assert.equal(status, 200)
    const parsed = body as { sessionId: string; messages: unknown[] }
    assert.equal(parsed.sessionId, 'h1')
    assert.deepEqual(parsed.messages, [])
  })

  test('GET /sessions?limit=? 分页与 400', async () => {
    const ok = await getJson('/sessions?limit=2')
    assert.equal(ok.status, 200)
    assert.equal((ok.body as { sessions: unknown[] }).sessions.length, 2)

    const bad = await getJson('/sessions?limit=-1')
    assert.equal(bad.status, 400)
    assert.equal((bad.body as { code: string }).code, 'bad.request')
  })

  test('CORS 头齐全', async () => {
    const { headers } = await getJson('/health')
    assert.equal(headers.get('access-control-allow-origin'), '*')
    assert.ok(headers.get('access-control-allow-methods')?.includes('GET'))
    assert.equal(headers.get('cache-control'), 'no-store')
    assert.ok(headers.get('content-type')?.includes('application/json'))
  })

  test('OPTIONS 预检 → 204 + CORS', async () => {
    const res = await fetch(`${baseUrl}/sessions`, { method: 'OPTIONS' })
    assert.equal(res.status, 204)
    assert.equal(res.headers.get('access-control-allow-origin'), '*')
    await res.text()
  })

  test('POST → 405', async () => {
    const res = await fetch(`${baseUrl}/sessions`, { method: 'POST' })
    assert.equal(res.status, 405)
    const body = (await res.json()) as { code: string }
    assert.equal(body.code, 'method.not.allowed')
  })

  test('未知路径 → 404', async () => {
    const { status, body } = await getJson('/definitely-not-here')
    assert.equal(status, 404)
    assert.equal((body as { code: string }).code, 'not.found')
  })

  test('HEAD /health → 200 且无 body', async () => {
    const res = await fetch(`${baseUrl}/health`, { method: 'HEAD' })
    assert.equal(res.status, 200)
    const text = await res.text()
    assert.equal(text, '')
    // 仍带 Content-Length,便于客户端知道有 body
    assert.ok(Number(res.headers.get('content-length')) > 0)
  })

  test('尾斜杠容忍', async () => {
    const { status } = await getJson('/sessions/')
    assert.equal(status, 200)
  })

  test('dispose 幂等,且之后连接被拒', async () => {
    await server.dispose()
    await server.dispose() // 第二次不抛
    await assert.rejects(() => fetch(`${baseUrl}/health`))
  })
})

describe('HTTP server 端口禁用', () => {
  test('httpPort = -1 时不监听,port 回 -1', async () => {
    const hostReader: HostSessionReader = {
      async list() {
        return []
      },
      async titles() {
        return new Map()
      },
      async exists() {
        return false
      },
    }
    const config: Config = {
      hostName: '127.0.0.1',
      listenPort: 0,
      httpPort: -1,
      logLevel: LogLevel.DEV,
      sessionIdleTimeoutMs: 60_000,
    }
    const disabled = createHttpServer(fakeCtx(), config, {
      host: { get: () => undefined, on() {}, off() {} },
      hostReader,
      sessionIndex: createMemorySessionIndex(),
    })
    assert.equal(await disabled.port, -1)
    await disabled.dispose()
  })
})

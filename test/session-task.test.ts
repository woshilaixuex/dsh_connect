import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHub } from '../src/hub/hub.js'
import { ErrorCodes, sessionTopic, type ReqFrame } from '../src/protocol/frame.js'
import { registerSessionTask } from '../src/tasks/session-task.js'
import { createMemorySessionIndex, type SessionIndex } from '../src/sessions/session-index.js'
import type { SessionRegistry, SendResult, WireMessage } from '../src/sessions/session-registry.js'
import type { HostCtx } from '../src/bridge/agent-bridge.js'
import { FakeConn, makeLogger, tick } from './helpers.js'

/** 记录调用的假注册表。 */
function makeRegistry(overrides: Partial<SessionRegistry> = {}) {
  const calls = {
    ensure: [] as { sessionId: string; cwd?: string }[],
    send: [] as { sessionId: string; prompt: string; chunks?: boolean }[],
    stop: [] as string[],
    release: [] as string[],
    respondApproval: [] as { sessionId: string; pendingId: string; allow: boolean }[],
  }
  const registry: SessionRegistry = {
    async ensure(sessionId, cwd) {
      calls.ensure.push(cwd === undefined ? { sessionId } : { sessionId, cwd })
    },
    async send(sessionId, prompt, options): Promise<SendResult> {
      calls.send.push({ sessionId, prompt, chunks: options?.chunks })
      return { sessionId, status: 'done', durationMs: 12 }
    },
    stop(sessionId) {
      calls.stop.push(sessionId)
      return true
    },
    async release(sessionId) {
      calls.release.push(sessionId)
    },
    history: () => undefined,
    liveIds: () => [],
    respondApproval(sessionId, pendingId, allow) {
      calls.respondApproval.push({ sessionId, pendingId, allow })
      return false
    },
    async disposeAll() {},
    ...overrides,
  }
  return { registry, calls }
}

function req(id: string, code: string, payload?: unknown): ReqFrame {
  return { v: 1, kind: 'req', id, code, ...(payload === undefined ? {} : { payload: payload as never }) }
}

/** 假宿主会话读取:默认「宿主什么都没有」,可按用例注入。 */
function makeHostReader(init: {
  host?: import('../src/sessions/session-mirror.js').HostSessionRecord[]
  titles?: Map<string, string>
  existIds?: string[]
} = {}) {
  const host = init.host ?? []
  const titles = init.titles ?? new Map<string, string>()
  const existIds = new Set(init.existIds ?? [])
  const calls = { exists: [] as string[] }
  const reader: import('../src/sessions/host-sessions.js').HostSessionReader = {
    async list() {
      return host
    },
    async titles() {
      return titles
    },
    async exists(sessionId) {
      calls.exists.push(sessionId)
      return existIds.has(sessionId)
    },
  }
  return { reader, calls }
}

let hub: ReturnType<typeof createHub>
let conn: FakeConn
let index: SessionIndex
let calls: ReturnType<typeof makeRegistry>['calls']
let host: HostCtx
let hostReaderCalls: ReturnType<typeof makeHostReader>['calls']

function setupRegistry(
  overrides: Partial<SessionRegistry> = {},
  options: {
    hostOverrides?: Partial<HostCtx>
    hostReader?: ReturnType<typeof makeHostReader>
    indexInit?: () => SessionIndex
  } = {},
): void {
  hub = createHub(makeLogger())
  conn = new FakeConn()
  index = options.indexInit ? options.indexInit() : createMemorySessionIndex()
  const made = makeRegistry(overrides)
  calls = made.calls
  host = {
    get: () => undefined,
    on: () => {},
    off: () => {},
    ...options.hostOverrides,
  }
  const hostReader = options.hostReader ?? makeHostReader()
  hostReaderCalls = hostReader.calls
  registerSessionTask({
    host,
    hub,
    logger: makeLogger(),
    index,
    registry: made.registry,
    hostReader: hostReader.reader,
  })
}

beforeEach(() => {
  setupRegistry()
})

async function resOf(id: string) {
  await tick(4)
  const frame = conn.frames.find((f) => f.kind === 'res' && (f as { id: string }).id === id)
  assert.ok(frame, `no res for ${id}`)
  if (frame.kind !== 'res') throw new Error('unreachable')
  return frame
}

describe('session.create', () => {
  test('不传 id:生成 client- 前缀并标记 source=client', async () => {
    hub.dispatch(conn, req('r1', 'session.create', { title: '测试会话' }))
    const res = await resOf('r1')
    assert.equal(res.ok, true)
    if (!res.ok) return
    const data = res.data as { sessionId: string; source: string; reused: boolean; title?: string }
    assert.ok(data.sessionId.startsWith('client-'), `expected client- prefix, got ${data.sessionId}`)
    assert.equal(data.source, 'client')
    assert.equal(data.reused, false)
    assert.equal(data.title, '测试会话')
    assert.deepEqual(calls.ensure, [{ sessionId: data.sessionId }])
    assert.equal(index.get(data.sessionId)!.title, '测试会话')
    assert.equal(index.get(data.sessionId)!.source, 'client')
  })

  test('传已有宿主会话 id:复用并标记 source=host', async () => {
    setupRegistry({}, { hostReader: makeHostReader({ existIds: ['session-42'] }) })
    hub.dispatch(conn, req('r1', 'session.create', { sessionId: 'session-42' }))
    const res = await resOf('r1')
    assert.equal(res.ok, true)
    if (!res.ok) return
    const data = res.data as { sessionId: string; source: string; reused: boolean }
    assert.equal(data.sessionId, 'session-42')
    assert.equal(data.source, 'host')
    assert.equal(data.reused, true)
    assert.deepEqual(hostReaderCalls.exists, ['session-42'])
    // 复用也要拉起(注册表会走 resume 路径)
    assert.deepEqual(calls.ensure, [{ sessionId: 'session-42' }])
  })

  test('传宿主没有的 id:用该 id 新建但标记 source=client', async () => {
    setupRegistry({}, { hostReader: makeHostReader({ existIds: [] }) })
    hub.dispatch(conn, req('r1', 'session.create', { sessionId: 'client-custom-1' }))
    const res = await resOf('r1')
    assert.equal(res.ok, true)
    if (!res.ok) return
    const data = res.data as { sessionId: string; source: string; reused: boolean }
    assert.equal(data.sessionId, 'client-custom-1')
    assert.equal(data.source, 'client')
    assert.equal(data.reused, false)
  })

  test('cwd 透传给注册表(便于挂进 workspace)', async () => {
    hub.dispatch(conn, req('r1', 'session.create', { cwd: 'D:/proj' }))
    const res = await resOf('r1')
    assert.equal(res.ok, true)
    assert.equal(calls.ensure[0]!.cwd, 'D:/proj')
  })

  test('拉起失败时回滚索引并报 agent.failed', async () => {
    setupRegistry({
      async ensure() {
        throw new Error('no model route')
      },
    })
    hub.dispatch(conn, req('r2', 'session.create', {}))
    const res = await resOf('r2')
    assert.equal(res.ok, false)
    if (res.ok) return
    assert.equal(res.code, ErrorCodes.AGENT_FAILED)
  })
})

describe('session.list / get', () => {
  test('list 返回索引内容并标注 live', async () => {
    setupRegistry({ liveIds: () => ['sess-b'] })
    index.upsert('sess-a', { title: 'A' })
    index.upsert('sess-b', { title: 'B' })
    hub.dispatch(conn, req('r1', 'session.list', {}))
    const res = await resOf('r1')
    assert.equal(res.ok, true)
    if (!res.ok) return
    const sessions = (res.data as { sessions: { sessionId: string; live: boolean }[] }).sessions
    assert.equal(sessions.length, 2)
    assert.equal(sessions.find((s) => s.sessionId === 'sess-b')!.live, true)
    assert.equal(sessions.find((s) => s.sessionId === 'sess-a')!.live, false)
  })

  test('list 默认不含软删', async () => {
    index.upsert('sess-a')
    index.softDelete('sess-a')
    hub.dispatch(conn, req('r1', 'session.list', {}))
    const res = await resOf('r1')
    if (!res.ok) return
    assert.deepEqual((res.data as { sessions: unknown[] }).sessions, [])
  })

  test('get 不存在报 session.not.found', async () => {
    hub.dispatch(conn, req('r1', 'session.get', { sessionId: 'nope' }))
    const res = await resOf('r1')
    assert.equal(res.ok, false)
    if (res.ok) return
    assert.equal(res.code, ErrorCodes.SESSION_NOT_FOUND)
  })

  test('get 缺 sessionId 报 bad.request', async () => {
    hub.dispatch(conn, req('r1', 'session.get', {}))
    const res = await resOf('r1')
    assert.equal(res.ok, false)
    if (res.ok) return
    assert.equal(res.code, ErrorCodes.BAD_REQUEST)
  })
})

describe('session.history', () => {
  test('活跃会话用内存历史', async () => {
    const messages: WireMessage[] = [
      { role: 'user', text: '你好', ts: 1 },
      { role: 'assistant', text: '收到', ts: 2 },
    ]
    setupRegistry({ history: () => messages })
    hub.dispatch(conn, req('r1', 'session.history', { sessionId: 'sess-x' }))
    const res = await resOf('r1')
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.deepEqual((res.data as { messages: WireMessage[] }).messages, messages)
  })

  test('非活跃会话回退宿主持久化日志', async () => {
    const persisted = {
      events: [
        { type: 'user/message', time: 10, data: { message: { content: [{ type: 'text', text: '问' }] } } },
        { type: 'assistant/message', time: 11, data: { message: { content: [{ type: 'text', text: '答' }] } } },
        { type: 'turn/start', time: 12, data: {} },
      ],
    }
    const sessionQuery = { readSession: async () => persisted }
    setupRegistry({}, { hostOverrides: { get: (key: string) => (key === 'sessionQuery' ? sessionQuery : undefined) } })
    hub.dispatch(conn, req('r1', 'session.history', { sessionId: 'sess-y' }))
    const res = await resOf('r1')
    assert.equal(res.ok, true)
    if (!res.ok) return
    const messages = (res.data as { messages: WireMessage[] }).messages
    assert.deepEqual(
      messages.map((m) => [m.role, m.text]),
      [
        ['user', '问'],
        ['assistant', '答'],
      ],
    )
  })

  test('宿主无 sessionQuery 时返回空历史', async () => {
    hub.dispatch(conn, req('r1', 'session.history', { sessionId: 'sess-z' }))
    const res = await resOf('r1')
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.deepEqual((res.data as { messages: unknown[] }).messages, [])
  })
})

describe('session.send / stop / delete', () => {
  function seedSession(id = 'sess-1'): string {
    index.upsert(id)
    return id
  }

  test('send 校验 sessionId 与 prompt', async () => {
    hub.dispatch(conn, req('r1', 'session.send', { sessionId: 'x' }))
    let res = await resOf('r1')
    assert.equal(res.ok, false)
    if (!res.ok) assert.equal(res.code, ErrorCodes.BAD_REQUEST)

    hub.dispatch(conn, req('r2', 'session.send', { prompt: 'hi' }))
    res = await resOf('r2')
    assert.equal(res.ok, false)
    if (!res.ok) assert.equal(res.code, ErrorCodes.BAD_REQUEST)
  })

  test('send 未登记的会话报 session.not.found', async () => {
    hub.dispatch(conn, req('r1', 'session.send', { sessionId: 'ghost', prompt: 'hi' }))
    const res = await resOf('r1')
    assert.equal(res.ok, false)
    if (!res.ok) return
    assert.equal(res.code, ErrorCodes.SESSION_NOT_FOUND)
  })

  test('send 正常路径透传 chunks 并返回结果', async () => {
    const id = seedSession()
    hub.dispatch(conn, req('r1', 'session.send', { sessionId: id, prompt: '你好', chunks: true }))
    const res = await resOf('r1')
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.deepEqual(res.data, { sessionId: id, status: 'done', durationMs: 12 })
    assert.deepEqual(calls.send, [{ sessionId: id, prompt: '你好', chunks: true }])
  })

  test('send 失败映射:resume 类错误 → session.resume-failed', async () => {
    const id = seedSession()
    setupRegistry({
      async send() {
        throw new Error('cannot resume session: not found in persistence')
      },
    })
    index.upsert(id)
    hub.dispatch(conn, req('r1', 'session.send', { sessionId: id, prompt: 'hi' }))
    const res = await resOf('r1')
    assert.equal(res.ok, false)
    if (res.ok) return
    assert.equal(res.code, ErrorCodes.SESSION_RESUME_FAILED)
  })

  test('send 其它失败 → agent.failed', async () => {
    const id = seedSession()
    setupRegistry({
      async send() {
        throw new Error('boom')
      },
    })
    index.upsert(id)
    hub.dispatch(conn, req('r1', 'session.send', { sessionId: id, prompt: 'hi' }))
    const res = await resOf('r1')
    assert.equal(res.ok, false)
    if (res.ok) return
    assert.equal(res.code, ErrorCodes.AGENT_FAILED)
  })

  test('stop 保留会话,返回 stopped', async () => {
    const id = seedSession()
    hub.dispatch(conn, req('r1', 'session.stop', { sessionId: id }))
    const res = await resOf('r1')
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.deepEqual(res.data, { sessionId: id, status: 'stopped' })
    assert.deepEqual(calls.stop, [id])
    // 会话未从索引移除
    assert.ok(index.get(id))
  })

  test('delete 先释放再软删,宿主文件保留(索引仍可 includeDeleted 查到)', async () => {
    const id = seedSession()
    hub.dispatch(conn, req('r1', 'session.delete', { sessionId: id }))
    const res = await resOf('r1')
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.deepEqual(res.data, { sessionId: id, deleted: true })
    assert.deepEqual(calls.release, [id])
    assert.deepEqual(index.list(), [])
    assert.equal(index.get(id)!.deleted, true)
  })

  test('delete 未知会话报 session.not.found', async () => {
    hub.dispatch(conn, req('r1', 'session.delete', { sessionId: 'ghost' }))
    const res = await resOf('r1')
    assert.equal(res.ok, false)
    if (res.ok) return
    assert.equal(res.code, ErrorCodes.SESSION_NOT_FOUND)
  })
})

describe('自动订阅(实机踩过的坑)', () => {
  test('session.send 让发起连接订阅该会话主题', async () => {
    // 场景:重启 dsh 后客户端重连,对**已有**会话发消息。
    // 若不自动订阅,agent 照常执行但客户端收不到任何事件 → 永远停在"运行中"。
    index.upsert('sess-sub')
    hub.dispatch(conn, req('r1', 'session.send', { sessionId: 'sess-sub', prompt: 'hi' }))
    await resOf('r1')

    hub.publish(sessionTopic('sess-sub'), { kind: 'assistant.message', text: 'x' } as never)
    const evt = conn.frames.find(
      (f) => f.kind === 'evt' && (f as { push: string }).push === sessionTopic('sess-sub'),
    )
    assert.ok(evt, 'session.send 后该连接应已订阅 session:sess-sub')
  })

  test('session.create 让发起连接订阅该会话主题', async () => {
    hub.dispatch(conn, req('r1', 'session.create', { title: 't' }))
    const res = await resOf('r1')
    assert.equal(res.ok, true)
    if (!res.ok) return
    const sessionId = (res.data as { sessionId: string }).sessionId

    hub.publish(sessionTopic(sessionId), { kind: 'agent.status', status: 'running' } as never)
    const evt = conn.frames.find(
      (f) => f.kind === 'evt' && (f as { push: string }).push === sessionTopic(sessionId),
    )
    assert.ok(evt, 'session.create 后该连接应已订阅该会话主题')
  })

  test('其它连接不受影响(仍只发给订阅者)', async () => {
    index.upsert('sess-sub')
    hub.dispatch(conn, req('r1', 'session.send', { sessionId: 'sess-sub', prompt: 'hi' }))
    await resOf('r1')

    const other = new FakeConn()
    hub.subscribe(other, sessionTopic('other')) // 订阅的是别的主题
    hub.publish(sessionTopic('sess-sub'), { kind: 'assistant.message', text: 'x' } as never)
    assert.equal(
      other.frames.filter((f) => f.kind === 'evt').length,
      0,
      '未订阅该会话的连接不应收到事件',
    )
  })
})

describe('注册/注销', () => {
  test('注销后接收码变为 unknown.code', async () => {
    const localIndex = createMemorySessionIndex()
    const localHub = createHub(makeLogger())
    const localConn = new FakeConn()
    const made = makeRegistry()
    const dispose = registerSessionTask({
      host: { get: () => undefined, on: () => {}, off: () => {} },
      hub: localHub,
      logger: makeLogger(),
      index: localIndex,
      registry: made.registry,
    })
    dispose()
    localHub.dispatch(localConn, req('r1', 'session.create', {}))
    await tick(4)
    const frame = localConn.frames[0]!
    assert.equal(frame.kind, 'res')
    if (frame.kind === 'res' && !frame.ok) assert.equal(frame.code, ErrorCodes.UNKNOWN_CODE)
  })
})

afterEach(() => {
  // 每个用例独立 hub/conn,无全局状态需要清理
})

describe('approval.respond', () => {
  test('命中时返回 outcome=allowed-once', async () => {
    setupRegistry({
      respondApproval: (sessionId, pendingId, allow) => {
        calls.respondApproval.push({ sessionId, pendingId, allow })
        return true
      },
    })
    hub.dispatch(conn, req('r1', 'approval.respond', { sessionId: 'sess-1', pendingId: 'approve-1', allow: true }))
    const res = await resOf('r1')
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.deepEqual(res.data, { pendingId: 'approve-1', outcome: 'allowed-once' })
    assert.deepEqual(calls.respondApproval, [{ sessionId: 'sess-1', pendingId: 'approve-1', allow: true }])
  })

  test('reject 返回 outcome=rejected', async () => {
    setupRegistry({ respondApproval: () => true })
    hub.dispatch(conn, req('r1', 'approval.respond', { sessionId: 'sess-1', pendingId: 'approve-1', allow: false }))
    const res = await resOf('r1')
    assert.equal(res.ok, true)
    if (!res.ok) return
    assert.deepEqual(res.data, { pendingId: 'approve-1', outcome: 'rejected' })
  })

  test('未命中返回 approval.not.found', async () => {
    hub.dispatch(conn, req('r1', 'approval.respond', { sessionId: 'sess-1', pendingId: 'approve-1', allow: true }))
    const res = await resOf('r1')
    assert.equal(res.ok, false)
    if (res.ok) return
    assert.equal(res.code, ErrorCodes.APPROVAL_NOT_FOUND)
  })

  test('字段缺失返回 bad.request', async () => {
    hub.dispatch(conn, req('r1', 'approval.respond', { sessionId: 'sess-1', allow: true }))
    const res = await resOf('r1')
    assert.equal(res.ok, false)
    if (res.ok) return
    assert.equal(res.code, ErrorCodes.BAD_REQUEST)
  })
})

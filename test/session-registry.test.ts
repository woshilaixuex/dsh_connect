import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHub } from '../src/hub/hub.js'
import { sessionTopic } from '../src/protocol/frame.js'
import { createSessionRegistry, type SessionRegistry, type WireMessage } from '../src/sessions/session-registry.js'
import { createMemorySessionIndex, type SessionIndex } from '../src/sessions/session-index.js'
import type { AgentRunAdapter, AgentTaskHandle, HostCtx } from '../src/bridge/agent-bridge.js'
import type { SessionEventLike } from '../src/bridge/event-map.js'
import { FakeConn, makeLogger, tick } from './helpers.js'

/** 可手动 settle 的假 agent。 */
class FakeAgent {
  readonly id: string
  messages: unknown[] = []
  cancelled = 0
  private idleResolvers: (() => void)[] = []

  constructor(id: string) {
    this.id = id
  }

  followup(message: unknown): void {
    this.messages.push(message)
  }

  whenIdle(): Promise<void> {
    return new Promise((resolve) => this.idleResolvers.push(resolve))
  }

  cancel(): void {
    this.cancelled++
    this.settle()
  }

  settle(): void {
    const resolvers = this.idleResolvers
    this.idleResolvers = []
    for (const resolve of resolvers) resolve()
  }
}

interface Opened {
  sessionId: string
  via: 'create' | 'resume'
  agent: FakeAgent
  disposed: number
}

/** 假适配器:记录 create/resume 调用;resume 可配置为失败。 */
function makeAdapter(options: { resumeFails?: boolean } = {}) {
  const opened: Opened[] = []
  const adapter: AgentRunAdapter = {
    kind: 'agents',
    async create(input) {
      const agent = new FakeAgent(input.sessionId)
      const record: Opened = { sessionId: input.sessionId, via: 'create', agent, disposed: 0 }
      opened.push(record)
      return {
        agent,
        dispose: async () => {
          record.disposed++
        },
      }
    },
    async resume(input) {
      if (options.resumeFails) throw new Error('no persisted session')
      const agent = new FakeAgent(input.sessionId)
      const record: Opened = { sessionId: input.sessionId, via: 'resume', agent, disposed: 0 }
      opened.push(record)
      return {
        agent,
        dispose: async () => {
          record.disposed++
        },
      }
    },
  }
  return { adapter, opened }
}

interface Harness {
  registry: SessionRegistry
  index: SessionIndex
  hub: ReturnType<typeof createHub>
  conn: FakeConn
  opened: Opened[]
  emitSession(sessionId: string, event: SessionEventLike): void
  emitAgentError(sessionId: string, error: unknown): void
}

function makeHarness(options: { resumeFails?: boolean; idleTimeoutMs?: number; loadHistory?: (id: string) => Promise<WireMessage[]> } = {}): Harness {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const host: HostCtx = {
    get: () => undefined,
    on: (event, handler) => {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      set.add(handler)
    },
    off: (event, handler) => {
      listeners.get(event)?.delete(handler)
    },
  }
  const fire = (event: string, ...args: unknown[]): void => {
    for (const handler of [...(listeners.get(event) ?? [])]) handler(...args)
  }

  const hub = createHub(makeLogger())
  const conn = new FakeConn()
  hub.subscribe(conn, sessionTopic('sess-1')) // 订阅测试会话主题
  const index = createMemorySessionIndex()
  const { adapter, opened } = makeAdapter(options)
  const registry = createSessionRegistry(host, hub, adapter, index, makeLogger(), {
    idleTimeoutMs: options.idleTimeoutMs ?? 60_000,
    ...(options.loadHistory === undefined ? {} : { loadHistory: options.loadHistory }),
  })

  return {
    registry,
    index,
    hub,
    conn,
    opened,
    emitSession: (sessionId, event) => fire('session/event', { id: sessionId }, event),
    emitAgentError: (sessionId, error) => fire('agent/error', { agent: { id: sessionId }, error }),
  }
}

let h: Harness

beforeEach(() => {
  h = makeHarness()
})

describe('常驻与恢复', () => {
  test('首次 send 走 create,并登记索引', async () => {
    const promise = h.registry.send('sess-1', '你好')
    await tick(4)
    assert.equal(h.opened.length, 1)
    assert.equal(h.opened[0]!.via, 'create')
    assert.equal(h.index.get('sess-1')!.sessionId, 'sess-1')

    h.opened[0]!.agent.settle()
    const result = await promise
    assert.equal(result.status, 'done')
    assert.equal(result.sessionId, 'sess-1')
  })

  test('已释放的会话再次 send 走 resume(上下文延续)', async () => {
    const first = h.registry.send('sess-1', '第一轮')
    await tick(4)
    h.opened[0]!.agent.settle()
    await first

    await h.registry.release('sess-1')
    assert.equal(h.opened[0]!.disposed, 1)

    const second = h.registry.send('sess-1', '第二轮')
    await tick(4)
    assert.equal(h.opened.length, 2)
    assert.equal(h.opened[1]!.via, 'resume')
    // 同一个 sessionId(宿主会加载历史)
    assert.equal(h.opened[1]!.sessionId, 'sess-1')

    h.opened[1]!.agent.settle()
    await second
  })

  test('resume 失败时回退 create', async () => {
    const harness = makeHarness({ resumeFails: true })
    const first = harness.registry.send('sess-1', '一轮')
    await tick(4)
    harness.opened[0]!.agent.settle()
    await first
    await harness.registry.release('sess-1')

    const second = harness.registry.send('sess-1', '二轮')
    await tick(4)
    assert.equal(harness.opened.length, 2)
    assert.equal(harness.opened[1]!.via, 'create') // resume 抛错后回退
    harness.opened[1]!.agent.settle()
    await second
  })

  test('活跃会话复用同一 agent,不重复 create', async () => {
    const first = h.registry.send('sess-1', '一')
    await tick(4)
    h.opened[0]!.agent.settle()
    await first

    const second = h.registry.send('sess-1', '二')
    await tick(4)
    assert.equal(h.opened.length, 1) // 没有新的 create/resume
    assert.equal(h.opened[0]!.agent.messages.length, 2)
    h.opened[0]!.agent.settle()
    await second
  })
})

describe('串行执行', () => {
  test('同一会话的消息排队,不并发', async () => {
    const a = h.registry.send('sess-1', '一')
    await tick(2)
    const b = h.registry.send('sess-1', '二')
    await tick(4)

    // 第一轮未结束,第二轮不应已投递
    assert.equal(h.opened[0]!.agent.messages.length, 1)

    h.opened[0]!.agent.settle()
    await tick(4)
    // 第一轮结束后才投递第二轮
    assert.equal(h.opened[0]!.agent.messages.length, 2)

    h.opened[0]!.agent.settle()
    await Promise.all([a, b])
  })

  test('不同会话可并行', async () => {
    h.hub.subscribe(h.conn, sessionTopic('sess-2'))
    const a = h.registry.send('sess-1', '一')
    const b = h.registry.send('sess-2', '二')
    await tick(4)
    assert.equal(h.opened.length, 2)
    for (const entry of h.opened) entry.agent.settle()
    await Promise.all([a, b])
  })
})

describe('事件推送到会话主题', () => {
  test('assistant.message → session:<id> 主题', async () => {
    const promise = h.registry.send('sess-1', '你好')
    await tick(4)

    h.emitSession('sess-1', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '收到' }] } },
    } as SessionEventLike)

    const evt = h.conn.frames.find(
      (f) =>
        f.kind === 'evt' &&
        (f as { push: string }).push === sessionTopic('sess-1') &&
        (f as { data?: { kind?: string } }).data?.kind === 'assistant.message',
    )
    assert.ok(evt)
    assert.deepEqual((evt as { data: unknown }).data, { kind: 'assistant.message', text: '收到' })

    h.opened[0]!.agent.settle()
    await promise
  })

  test('send 先回显 session.user-message', async () => {
    const promise = h.registry.send('sess-1', '你好')
    await tick(4)
    const first = h.conn.frames.find((f) => f.kind === 'evt')
    assert.deepEqual((first as { data: unknown }).data, { kind: 'session.user-message', text: '你好' })
    h.opened[0]!.agent.settle()
    await promise
  })

  test('未激活的会话事件不推送', async () => {
    h.emitSession('sess-unknown', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'x' }] } },
    } as SessionEventLike)
    assert.equal(h.conn.frames.length, 0)
  })

  test('agent.error 记入结果,status 为 failed', async () => {
    const promise = h.registry.send('sess-1', '会失败')
    await tick(4)
    h.emitAgentError('sess-1', new Error('炸了'))
    h.opened[0]!.agent.settle()
    const result = await promise
    assert.equal(result.status, 'failed')
    assert.equal(result.error, '炸了')
  })
})

describe('停止与回收', () => {
  test('stop 打断当前轮但保留会话', async () => {
    const promise = h.registry.send('sess-1', '长任务')
    await tick(4)
    assert.equal(h.registry.stop('sess-1'), true)
    assert.equal(h.opened[0]!.agent.cancelled, 1)
    await promise
    // 会话仍活跃
    assert.deepEqual(h.registry.liveIds(), ['sess-1'])
  })

  test('stop 对未激活会话返回 false', () => {
    assert.equal(h.registry.stop('nope'), false)
  })

  test('空闲超时自动 release', async () => {
    const harness = makeHarness({ idleTimeoutMs: 20 })
    const promise = harness.registry.send('sess-1', '一轮')
    await tick(4)
    harness.opened[0]!.agent.settle()
    await promise

    assert.deepEqual(harness.registry.liveIds(), ['sess-1'])
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.deepEqual(harness.registry.liveIds(), [])
    assert.equal(harness.opened[0]!.disposed, 1)
  })

  test('release 幂等', async () => {
    await h.registry.ensure('sess-1')
    await h.registry.release('sess-1')
    await h.registry.release('sess-1')
    assert.equal(h.opened[0]!.disposed, 1)
  })

  test('disposeAll 释放全部并卸载监听', async () => {
    await h.registry.ensure('sess-1')
    h.hub.subscribe(h.conn, sessionTopic('sess-2'))
    await h.registry.ensure('sess-2')
    await h.registry.disposeAll()
    assert.equal(h.registry.liveIds().length, 0)
    assert.equal(h.opened.every((o) => o.disposed === 1), true)

    // 监听已卸载:不再有推送
    const before = h.conn.frames.length
    h.emitSession('sess-1', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: 'x' }] } },
    } as SessionEventLike)
    assert.equal(h.conn.frames.length, before)
  })
})

describe('内存历史', () => {
  test('记录用户与助手消息', async () => {
    const promise = h.registry.send('sess-1', '你好')
    await tick(4)
    h.emitSession('sess-1', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '你好呀' }] } },
    } as SessionEventLike)
    h.opened[0]!.agent.settle()
    await promise

    const history = h.registry.history('sess-1')!
    assert.equal(history.length, 2)
    assert.deepEqual(
      history.map((m) => [m.role, m.text]),
      [
        ['user', '你好'],
        ['assistant', '你好呀'],
      ],
    )
  })

  test('未激活会话返回 undefined', () => {
    assert.equal(h.registry.history('nope'), undefined)
  })

  test('resume 后把宿主持久化历史载入内存(补回 resume 前的消息)', async () => {
    const persisted: WireMessage[] = [
      { role: 'user', text: '旧问题', ts: 1 },
      { role: 'assistant', text: '旧回答', ts: 2 },
    ]
    const harness = makeHarness({ loadHistory: async () => persisted })

    // 第一轮:create 路径,不加载历史
    const first = harness.registry.send('sess-1', '新问题')
    await tick(4)
    harness.opened[0]!.agent.settle()
    await first
    await harness.registry.release('sess-1')

    // 第二轮:resume 路径,应载入持久化历史
    const second = harness.registry.send('sess-1', '又一个问题')
    await tick(4)
    assert.equal(harness.opened[1]!.via, 'resume')
    harness.emitSession('sess-1', {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '新回答' }] } },
    } as SessionEventLike)
    harness.opened[1]!.agent.settle()
    await second

    const history = harness.registry.history('sess-1')!
    assert.deepEqual(
      history.map((m) => [m.role, m.text]),
      [
        ['user', '旧问题'], // 来自持久化(resume 时载入)
        ['assistant', '旧回答'],
        ['user', '又一个问题'],
        ['assistant', '新回答'],
      ],
    )
  })

  test('resume 但未注入 loadHistory 时不报错,历史从空开始', async () => {
    const harness = makeHarness()
    const first = harness.registry.send('sess-1', '一')
    await tick(4)
    harness.opened[0]!.agent.settle()
    await first
    await harness.registry.release('sess-1')

    const second = harness.registry.send('sess-1', '二')
    await tick(4)
    assert.equal(harness.opened[1]!.via, 'resume')
    harness.opened[1]!.agent.settle()
    await second
    assert.deepEqual(harness.registry.history('sess-1')!.map((m) => m.text), ['二'])
  })
})

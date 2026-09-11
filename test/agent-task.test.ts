import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHub } from '../src/hub/hub.js'
import { ErrorCodes, type ReqFrame } from '../src/protocol/frame.js'
import { registerAgentTask } from '../src/tasks/agent-task.js'
import type { HostCtx } from '../src/bridge/agent-bridge.js'
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
  }

  /** 测试用:让 whenIdle 落定。 */
  settle(): void {
    const resolvers = this.idleResolvers
    this.idleResolvers = []
    for (const resolve of resolvers) resolve()
  }
}

interface CreatedEntry {
  options: { sessionId: string; meta?: { cwd?: string }; agentOptions?: { provider?: string; model?: string } }
  agent: FakeAgent
  disposed: number
}

/** 假 agents 宿主服务:记录 create/dispose 调用。
 *  create 刻意依赖 this(宿主真实实现第一步就是 this.ctx),
 *  一旦桥接把方法解构出来单存导致接收者丢失,这里会直接抛错暴露。 */
function makeAgentsService() {
  const created: CreatedEntry[] = []
  const service = {
    async create(this: unknown, options: unknown) {
      if (this === undefined) throw new Error('agents.create called without receiver (this lost)')
      const opts = options as { sessionId: string }
      const entry: CreatedEntry = { options: opts, agent: new FakeAgent(opts.sessionId), disposed: 0 }
      created.push(entry)
      return {
        agent: entry.agent,
        dispose: async () => {
          entry.disposed++
        },
      }
    },
  }
  return { service, created }
}

interface HostHarness {
  host: HostCtx
  emitSession(sessionId: string, event: SessionEventLike): void
  emitAgentStatus(agentId: string, status: string): void
  emitAgentError(agentId: string, error: unknown): void
}

/** 假宿主 ctx:get('agents'/'agentDefaultModel') 可注入;on/off 记录监听器供 emit 回放。 */
function makeHost(agents?: unknown, defaultModel?: unknown): HostHarness {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const host: HostCtx = {
    get: (key: string) => {
      if (key === 'agents') return agents
      if (key === 'agentDefaultModel') return defaultModel
      return undefined
    },
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
  return {
    host,
    emitSession: (sessionId, event) => fire('session/event', { id: sessionId }, event),
    emitAgentStatus: (agentId, status) => fire('agent/status', { agent: { id: agentId }, status }),
    emitAgentError: (agentId, error) => fire('agent/error', { agent: { id: agentId }, error }),
  }
}

function req(id: string, code: string, payload?: unknown): ReqFrame {
  return { v: 1, kind: 'req', id, code, ...(payload === undefined ? {} : { payload: payload as never }) }
}

let hub: ReturnType<typeof createHub>
let conn: FakeConn
let agents: ReturnType<typeof makeAgentsService>
let host: HostHarness

/** 假宿主默认模型服务(hostDefaultModel=false 时不注入)。 */
const HOST_DEFAULT_MODEL = {
  currentSelection: () => ({ provider: 'host-provider', model: 'host-model', reasoningEffort: 'medium' }),
}

function setup(agentsService?: unknown, hostDefaultModel: unknown = HOST_DEFAULT_MODEL, taskOptions?: { provider?: string; model?: string }): void {
  hub = createHub(makeLogger())
  conn = new FakeConn()
  agents = makeAgentsService()
  host = makeHost(agentsService ?? agents.service, hostDefaultModel === false ? undefined : hostDefaultModel)
  registerAgentTask(host.host, hub, makeLogger(), taskOptions ?? {})
}

beforeEach(() => {
  setup()
})

describe('agent.run 全流程', () => {
  test('拉起 agent、自动订阅任务主题、事件回推、静默后 res done', async () => {
    hub.dispatch(conn, req('r1', 'agent.run', { prompt: '你好' }))
    await tick(6)

    // 已拉起 agent:sessionId 为 remote-*;消息已投递
    assert.equal(agents.created.length, 1)
    const entry = agents.created[0]!
    assert.ok(entry.options.sessionId.startsWith('remote-'))
    // 未显式配模型时,回退宿主默认模型(实机:agent 缺 provider/model 会直接报错)
    assert.deepEqual(entry.options.agentOptions, {
      provider: 'host-provider',
      model: 'host-model',
      reasoningEffort: 'medium',
    })
    assert.equal(entry.agent.messages.length, 1)
    const message = entry.agent.messages[0] as { role: string; content: { type: string; text: string }[]; source: { kind: string } }
    assert.equal(message.role, 'user')
    assert.equal(message.content[0]!.text, '你好')
    assert.equal(message.source.kind, 'user')
    const sessionId = entry.options.sessionId
    const channel = `task:${sessionId}`

    // 尚无 res(任务运行中),事件通过 evt 回推
    assert.equal(conn.frames.length, 0)
    host.emitAgentStatus(sessionId, 'running')
    host.emitSession(sessionId, {
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '收到' }] } },
    } as SessionEventLike)
    assert.equal(conn.frames.length, 2)
    const statusEvt = conn.frames[0]!
    assert.equal(statusEvt.kind, 'evt')
    if (statusEvt.kind === 'evt') {
      assert.equal(statusEvt.push, channel)
      assert.deepEqual(statusEvt.data, { kind: 'agent.status', status: 'running' })
    }
    const msgEvt = conn.frames[1]!
    if (msgEvt.kind === 'evt') {
      assert.deepEqual(msgEvt.data, { kind: 'assistant.message', text: '收到', turn: 1, step: 1 })
    }

    // 静默 → res done,并 dispose
    entry.agent.settle()
    await tick(6)
    const res = conn.frames.at(-1)!
    assert.equal(res.kind, 'res')
    if (res.kind !== 'res' || !res.ok) return
    assert.equal(res.id, 'r1')
    const data = res.data as { taskId: string; sessionId: string; status: string; durationMs: number }
    assert.equal(data.taskId, sessionId)
    assert.equal(data.status, 'done')
    assert.equal(typeof data.durationMs, 'number')
    assert.equal(entry.disposed, 1)

    // 收尾后清理:宿主监听已移除,迟到的事件不再回推
    host.emitSession(sessionId, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '迟到' }] } } } as SessionEventLike)
    assert.equal(conn.frames.length, 3)
  })

  test('assistant/chunk 默认不转发;chunks:true 才转发', async () => {
    hub.dispatch(conn, req('r2', 'agent.run', { prompt: '流式' }))
    await tick(6)
    const entry = agents.created[0]!
    const sessionId = entry.options.sessionId
    const chunk = { type: 'text-delta', index: 0, text: '你' } as never
    host.emitSession(sessionId, { type: 'assistant/chunk', data: { chunk } } as SessionEventLike)
    assert.equal(conn.frames.length, 0)

    const conn2 = new FakeConn()
    hub.dispatch(conn2, req('r3', 'agent.run', { prompt: '流式', chunks: true }))
    await tick(6)
    const entry2 = agents.created[1]!
    host.emitSession(entry2.options.sessionId, { type: 'assistant/chunk', data: { chunk } } as SessionEventLike)
    const evt = conn2.frames[0]!
    assert.equal(evt.kind, 'evt')
    if (evt.kind === 'evt') {
      assert.deepEqual(evt.data, { kind: 'assistant.chunk', chunk })
    }
    entry2.agent.settle()
    await tick(6)
  })

  test('参数校验与宿主缺失', async () => {
    // prompt 缺失 → bad.request
    setup()
    hub.dispatch(conn, req('b1', 'agent.run', {}))
    await tick(6)
    let frame = conn.frames[0]!
    assert.equal(frame.kind, 'res')
    if (frame.kind === 'res' && !frame.ok) assert.equal(frame.code, ErrorCodes.BAD_REQUEST)

    // 宿主无 agents → host.unavailable(false 显式传入,禁用默认 agents 桩)
    setup(false)
    hub.dispatch(conn, req('b2', 'agent.run', { prompt: 'hi' }))
    await tick(6)
    frame = conn.frames[0]!
    assert.equal(frame.kind, 'res')
    if (frame.kind === 'res' && !frame.ok) assert.equal(frame.code, ErrorCodes.HOST_UNAVAILABLE)
  })
})

describe('模型路由', () => {
  test('显式配置 provider/model 时覆盖宿主默认', async () => {
    setup(undefined, undefined, { provider: 'cfg-provider', model: 'cfg-model' })
    hub.dispatch(conn, req('m1', 'agent.run', { prompt: 'hi' }))
    await tick(6)
    assert.deepEqual(agents.created[0]!.options.agentOptions, { provider: 'cfg-provider', model: 'cfg-model' })
    agents.created[0]!.agent.settle()
    await tick(6)
  })

  test('宿主无默认模型服务时 agentOptions 为 undefined(交给宿主报错)', async () => {
    setup(undefined, false)
    hub.dispatch(conn, req('m2', 'agent.run', { prompt: 'hi' }))
    await tick(6)
    assert.equal(agents.created[0]!.options.agentOptions, undefined)
    agents.created[0]!.agent.settle()
    await tick(6)
  })
})

describe('agent.error 反映到最终结果', () => {
  test('回推 agent.error 事件,并把 status 标为 failed', async () => {
    hub.dispatch(conn, req('r1', 'agent.run', { prompt: '会失败' }))
    await tick(6)
    const entry = agents.created[0]!
    const sessionId = entry.options.sessionId

    host.emitAgentError(sessionId, new Error('工具炸了'))
    const evt = conn.frames[0]!
    assert.equal(evt.kind, 'evt')
    if (evt.kind === 'evt') {
      assert.deepEqual(evt.data, { kind: 'agent.error', message: '工具炸了' })
    }

    entry.agent.settle()
    await tick(6)
    const res = conn.frames.at(-1)!
    assert.equal(res.kind, 'res')
    if (res.kind !== 'res' || !res.ok) return
    const data = res.data as { status: string; error: string }
    assert.equal(data.status, 'failed')
    assert.equal(data.error, '工具炸了')
  })
})

describe('agent.stop 与连接断开', () => {
  test('发起连接可 stop:agent.cancel 触发,run 收尾为 stopped', async () => {
    hub.dispatch(conn, req('r1', 'agent.run', { prompt: '干活' }))
    await tick(6)
    const entry = agents.created[0]!
    const sessionId = entry.options.sessionId

    hub.dispatch(conn, req('s1', 'agent.stop', { taskId: sessionId }))
    await tick(6)
    assert.equal(entry.agent.cancelled, 1)
    const stopRes = conn.frames[0]!
    assert.equal(stopRes.kind, 'res')
    if (stopRes.kind === 'res' && stopRes.ok) {
      assert.deepEqual(stopRes.data, { taskId: sessionId, status: 'stopped' })
    }

    // run 循环随 cancel 静默,回 stopped 摘要并只 dispose 一次
    entry.agent.settle()
    await tick(6)
    const runRes = conn.frames.at(-1)!
    assert.equal(runRes.kind, 'res')
    if (runRes.kind === 'res' && runRes.ok) {
      assert.equal((runRes.data as { status: string }).status, 'stopped')
    }
    assert.equal(entry.disposed, 1)
  })

  test('非发起连接 stop 被拒;未知 taskId 报 not found', async () => {
    hub.dispatch(conn, req('r1', 'agent.run', { prompt: '干活' }))
    await tick(6)
    const sessionId = agents.created[0]!.options.sessionId

    const other = new FakeConn()
    hub.dispatch(other, req('s2', 'agent.stop', { taskId: sessionId }))
    await tick(6)
    const forbidden = other.frames[0]!
    assert.equal(forbidden.kind, 'res')
    if (forbidden.kind === 'res' && !forbidden.ok) assert.equal(forbidden.code, ErrorCodes.FORBIDDEN)

    hub.dispatch(conn, req('s3', 'agent.stop', { taskId: 'no-such-task' }))
    await tick(6)
    const notFound = conn.frames[0]!
    if (notFound.kind === 'res' && !notFound.ok) assert.equal(notFound.code, ErrorCodes.AGENT_NOT_FOUND)

    hub.dispatch(conn, req('s4', 'agent.stop', {}))
    await tick(6)
    const bad = conn.frames[1]!
    if (bad.kind === 'res' && !bad.ok) assert.equal(bad.code, ErrorCodes.BAD_REQUEST)

    agents.created[0]!.agent.settle()
    await tick(6)
  })

  test('连接断开:任务被 cancel + dispose,清理后 stop 报 not found', async () => {
    hub.dispatch(conn, req('r1', 'agent.run', { prompt: '长任务' }))
    await tick(6)
    const entry = agents.created[0]!
    const sessionId = entry.options.sessionId
    assert.equal(entry.disposed, 0)

    // 模拟服务端:连接关闭后 clearConn(此时 send 变 no-op)
    conn.close()
    hub.clearConn(conn)
    await tick(6)
    assert.equal(entry.agent.cancelled, 1)
    assert.equal(entry.disposed, 1)

    // 断开期间 whenIdle 落定 → run 结束但不再回 res(连接已关)
    entry.agent.settle()
    await tick(6)
    assert.equal(conn.frames.length, 0)

    // 任务已清理,stop 找不到
    hub.dispatch(conn, req('s1', 'agent.stop', { taskId: sessionId }))
    await tick(6)
    assert.equal(conn.frames.length, 0) // 连接已关,send 静默
  })
})

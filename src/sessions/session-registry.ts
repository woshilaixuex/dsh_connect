/**
 * 会话注册表:管理「会话 ↔ 常驻 agent」的映射。
 *
 * 设计要点(与一次性任务 agent-task 的区别):
 *  - **常驻**:会话首次使用时拉起 agent 并保活,后续消息复用同一个 agent(上下文天然延续);
 *  - **空闲回收**:闲置超过 idleTimeoutMs 后 dispose agent,**会话本身留在宿主**(jsonl 已落盘);
 *  - **恢复**:agent 被回收后再发消息,先 resume 宿主持久化会话,失败回退 create;
 *  - **串行**:同一会话的消息排队执行(避免并发 followup 语义混乱),不同会话可并行。
 *
 * 宿主事件用**一组全局监听**统一接收,内部按 active map 分发到对应会话主题
 * (而非每个会话挂一组监听)。
 */

import type { Hub, LoggerLike } from '../hub/hub.js'
import { sessionTopic } from '../protocol/frame.js'
import type { JsonValue } from '../protocol/frame.js'
import {
  buildUserMessage,
  type AgentRunAdapter,
  type AgentTaskHandle,
  type HostCtx,
} from '../bridge/agent-bridge.js'
import { mapSessionEvent, type SessionEventLike } from '../bridge/event-map.js'
import type { SessionIndex } from './session-index.js'

export interface SessionSendOptions {
  chunks?: boolean
}

export interface SendResult {
  sessionId: string
  status: 'done' | 'stopped' | 'failed'
  durationMs: number
  error?: string
}

/** 线协议格式的一条会话消息。 */
export interface WireMessage {
  role: 'user' | 'assistant'
  text: string
  ts: number
  kind?: 'assistant.message' | 'session.user-message'
}

export interface SessionRegistry {
  /** 确保会话有活跃 agent(复用 / resume / create)。 */
  ensure(sessionId: string): Promise<void>
  /** 往会话发一条消息并等本轮结束(同会话串行)。 */
  send(sessionId: string, prompt: string, options?: SessionSendOptions): Promise<SendResult>
  /** 打断当前轮(保留会话)。 */
  stop(sessionId: string): boolean
  /** 释放会话的常驻 agent(会话留在宿主)。幂等。 */
  release(sessionId: string): Promise<void>
  /** 活跃会话的内存消息历史;会话未激活时返回 undefined(调用方回退宿主持久化)。 */
  history(sessionId: string): WireMessage[] | undefined
  /** 当前活跃(常驻)的会话 id。 */
  liveIds(): string[]
  /** 释放全部并卸载宿主监听(插件卸载用)。 */
  disposeAll(): Promise<void>
}

export interface SessionRegistryOptions {
  /** 空闲回收阈值(ms)。 */
  idleTimeoutMs: number
  /** 显式模型路由(缺省用宿主默认)。 */
  provider?: string
  model?: string
  cwd?: string
  /**
   * 读取宿主持久化历史。resume 后用它补齐内存消息日志,
   * 否则恢复后的会话会「忘记」resume 之前的对话历史。
   */
  loadHistory?: (sessionId: string) => Promise<WireMessage[]>
}

interface LiveSession {
  sessionId: string
  handle: AgentTaskHandle
  status: 'idle' | 'running'
  /** 本轮是否转发 assistant.chunk。 */
  chunks: boolean
  /** 串行队列尾(同会话消息串行执行)。 */
  queue: Promise<unknown>
  idleTimer?: ReturnType<typeof setTimeout>
  lastError?: string
  /** 活跃期内存消息日志(宿主落盘有延迟,活跃会话用这份保证 history 准确)。 */
  messages: WireMessage[]
}

/** 内存消息日志上限(超出丢弃最旧的,避免长会话吃内存)。 */
const MAX_MEMORY_MESSAGES = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 追加一条内存消息,超出上限丢最旧的。 */
function pushMessage(log: WireMessage[], message: WireMessage): void {
  log.push(message)
  if (log.length > MAX_MEMORY_MESSAGES) log.splice(0, log.length - MAX_MEMORY_MESSAGES)
}

/** 会话上下文里可见的 user-message 回显(便于多端同步)。 */
function userMessagePayload(text: string): Record<string, unknown> {
  return { kind: 'session.user-message', text }
}

export function createSessionRegistry(
  ctx: HostCtx,
  hub: Hub,
  adapter: AgentRunAdapter,
  index: SessionIndex,
  logger: LoggerLike,
  options: SessionRegistryOptions,
): SessionRegistry {
  const active = new Map<string, LiveSession>()
  let disposed = false

  // ── 宿主事件:一组全局监听,按 sessionId 分发 ──────────────────────────────
  const onSessionEvent = (session: unknown, event: unknown): void => {
    const sessionId = isRecord(session) && typeof session.id === 'string' ? session.id : undefined
    if (!sessionId) return
    const live = active.get(sessionId)
    if (!live) return
    const payload = mapSessionEvent(event as SessionEventLike)
    if (!payload) return
    if (payload.kind === 'assistant.chunk' && !live.chunks) return
    // 末条 assistant 文本计入索引预览,并记进内存历史
    if (payload.kind === 'assistant.message' && typeof payload.text === 'string') {
      index.touch(sessionId, { lastMessage: payload.text, messageDelta: 1 })
      pushMessage(live.messages, { role: 'assistant', text: payload.text, ts: Date.now(), kind: 'assistant.message' })
    }
    hub.publish(sessionTopic(sessionId), payload as unknown as JsonValue)
  }

  const onAgentStatus = (arg: unknown): void => {
    const info = isRecord(arg) ? arg : {}
    const agent = isRecord(info.agent) ? info.agent : undefined
    const sessionId = agent && typeof agent.id === 'string' ? agent.id : undefined
    if (!sessionId || !active.has(sessionId)) return
    hub.publish(sessionTopic(sessionId), {
      kind: 'agent.status',
      status: typeof info.status === 'string' ? info.status : 'unknown',
    } as unknown as JsonValue)
  }

  const onAgentError = (arg: unknown): void => {
    const info = isRecord(arg) ? arg : {}
    const agent = isRecord(info.agent) ? info.agent : undefined
    const sessionId = agent && typeof agent.id === 'string' ? agent.id : undefined
    const live = sessionId ? active.get(sessionId) : undefined
    if (!sessionId || !live) return
    const message = errorMessage(info.error)
    live.lastError = message
    hub.publish(sessionTopic(sessionId), { kind: 'agent.error', message } as unknown as JsonValue)
  }

  ctx.on('session/event', onSessionEvent)
  ctx.on('agent/status', onAgentStatus)
  ctx.on('agent/error', onAgentError)

  // ── 空闲回收 ──────────────────────────────────────────────────────────────

  function clearIdle(live: LiveSession): void {
    if (live.idleTimer !== undefined) {
      clearTimeout(live.idleTimer)
      live.idleTimer = undefined
    }
  }

  function armIdle(sessionId: string): void {
    const live = active.get(sessionId)
    if (!live) return
    clearIdle(live)
    live.idleTimer = setTimeout(() => {
      void release(sessionId)
    }, options.idleTimeoutMs)
    // 回收定时器不应阻止进程退出
    live.idleTimer.unref?.()
  }

  // ── 打开 / 释放 ───────────────────────────────────────────────────────────

  async function open(sessionId: string): Promise<LiveSession> {
    const existing = active.get(sessionId)
    if (existing) return existing

    const input = { sessionId, provider: options.provider, model: options.model, cwd: options.cwd }
    let handle: AgentTaskHandle
    let resumed = false
    // 索引里有过记录 → 会话在宿主持久化过,优先 resume(延续上下文);
    // 否则(以及 resume 失败时)新建。
    const known = index.get(sessionId) !== undefined
    if (known) {
      try {
        handle = await adapter.resume(input)
        resumed = true
        logger.info('session resumed: %s', sessionId)
      } catch (error) {
        logger.warn('resume session %s failed, falling back to create: %o', sessionId, error)
        handle = await adapter.create(input)
        logger.info('session created (after resume failure): %s', sessionId)
      }
    } else {
      handle = await adapter.create(input)
      index.upsert(sessionId)
      logger.info('session created: %s', sessionId)
    }

    // resume 起来的会话:把宿主持久化历史载入内存,
    // 否则恢复后的 history 只会有 resume 之后的新消息
    let messages: WireMessage[] = []
    if (resumed && options.loadHistory) {
      try {
        messages = await options.loadHistory(sessionId)
      } catch (error) {
        logger.warn('load history for %s failed: %o', sessionId, error)
      }
    }

    const live: LiveSession = {
      sessionId,
      handle,
      status: 'idle',
      chunks: false,
      queue: Promise.resolve(),
      messages,
    }
    active.set(sessionId, live)
    return live
  }

  async function release(sessionId: string): Promise<void> {
    const live = active.get(sessionId)
    if (!live) return
    active.delete(sessionId)
    clearIdle(live)
    try {
      await live.handle.dispose()
      logger.info('session released (idle): %s', sessionId)
    } catch (error) {
      logger.warn('dispose session %s failed: %o', sessionId, error)
    }
  }

  // ── 发送(串行) ───────────────────────────────────────────────────────────

  async function runTurn(live: LiveSession, prompt: string): Promise<SendResult> {
    const startedAt = Date.now()
    live.status = 'running'
    live.lastError = undefined
    pushMessage(live.messages, { role: 'user', text: prompt, ts: startedAt, kind: 'session.user-message' })
    hub.publish(sessionTopic(live.sessionId), userMessagePayload(prompt) as unknown as JsonValue)

    try {
      live.handle.agent.followup(buildUserMessage(prompt))
    } catch (error) {
      live.status = 'idle'
      throw error
    }
    try {
      await live.handle.agent.whenIdle()
    } catch (error) {
      // stop 或 dispose 打断属预期
      logger.warn('whenIdle for session %s interrupted: %o', live.sessionId, error)
    }
    live.status = 'idle'

    const status = live.lastError ? 'failed' : 'done'
    return {
      sessionId: live.sessionId,
      status,
      durationMs: Date.now() - startedAt,
      ...(live.lastError === undefined ? {} : { error: live.lastError }),
    }
  }

  async function send(sessionId: string, prompt: string, sendOptions: SessionSendOptions = {}): Promise<SendResult> {
    const live = await open(sessionId)
    live.chunks = sendOptions.chunks === true
    clearIdle(live) // 执行期间不回收
    index.touch(sessionId, { lastMessage: prompt, messageDelta: 1 })

    // 同会话串行:把本轮挂到队列尾
    const turn = live.queue.then(() => runTurn(live, prompt))
    live.queue = turn.catch(() => {}) // 队列不因单轮失败而断裂
    try {
      return await turn
    } finally {
      if (!disposed && active.get(sessionId) === live) armIdle(sessionId)
    }
  }

  function stop(sessionId: string): boolean {
    const live = active.get(sessionId)
    if (!live) return false
    try {
      live.handle.agent.cancel?.({ kind: 'user' })
      return true
    } catch (error) {
      logger.warn('cancel session %s failed: %o', sessionId, error)
      return false
    }
  }

  async function ensure(sessionId: string): Promise<void> {
    await open(sessionId)
  }

  return {
    ensure,

    send,

    stop,

    release,

    history(sessionId) {
      const live = active.get(sessionId)
      return live ? [...live.messages] : undefined
    },

    liveIds() {
      return [...active.keys()]
    },

    async disposeAll() {
      disposed = true
      ctx.off('session/event', onSessionEvent)
      ctx.off('agent/status', onAgentStatus)
      ctx.off('agent/error', onAgentError)
      await Promise.all([...active.keys()].map((id) => release(id)))
    },
  }
}

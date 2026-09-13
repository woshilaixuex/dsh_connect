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

import { randomUUID } from 'node:crypto'
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

/** 宿主审批的 outcome(结构类型,不 import 宿主)。 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** 宿主 approval/request 事件载荷的最小结构面。 */
interface ApprovalRequestLike {
  agent?: { id?: unknown }
  toolName?: unknown
  callId?: unknown
  reason?: unknown
  signal?: {
    addEventListener?: (type: 'abort', listener: () => void, options?: unknown) => void
    removeEventListener?: (type: 'abort', listener: () => void) => void
  }
}

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
  /** 确保会话有活跃 agent(复用 / resume / create)。`cwd` 仅在新会话创建时生效。 */
  ensure(sessionId: string, cwd?: string): Promise<void>
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
  /**
   * 回复一个待决的审批请求。
   * 命中且 sessionId 匹配才生效(防跨会话误批);先到先得。
   * @returns 是否命中并已认领。
   */
  respondApproval(sessionId: string, pendingId: string, allow: boolean): boolean
  /** 释放全部并卸载宿主监听(插件卸载用)。 */
  disposeAll(): Promise<void>
}

export interface SessionRegistryOptions {
  /** 空闲回收阈值(ms)。 */
  idleTimeoutMs: number
  /** 审批请求超时(ms):客户端不回复时自动拒绝。 */
  approvalTimeoutMs: number
  /** 显式模型路由(缺省用宿主默认)。 */
  provider?: string
  model?: string
  cwd?: string
  /**
   * 读取宿主持久化历史。resume 后用它补齐内存消息日志,
   * 否则恢复后的会话会「忘记」resume 之前的对话历史。
   */
  loadHistory?: (sessionId: string) => Promise<WireMessage[]>
  /**
   * 判定该会话在宿主侧是否已存在(已持久化)。
   * 决定 resume 还是 create:**必须**比索引更权威 ——
   * 对已持久化但非 live 的 id 直接 create 会异步碰撞报错。
   * 未注入时退化为「索引里有记录即视为存在」。
   */
  probeSession?: (sessionId: string) => Promise<boolean>
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

/** 一条待客户端回复的审批请求。 */
interface PendingApproval {
  sessionId: string
  settle: (outcome: ApprovalOutcome) => void
  timer: ReturnType<typeof setTimeout>
  onAbort?: () => void
  signal?: { removeEventListener?: (type: 'abort', listener: () => void) => void }
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
  const pendingApprovals = new Map<string, PendingApproval>()
  let disposed = false

  // ── 宿主事件:一组全局监听,按 sessionId 分发 ──────────────────────────────

  /**
   * 用宿主工具定义给 tool.call 补一个人类可读标题(复用 presentCall,不自己拼)。
   * 拿不到就返回 undefined,调用方退化为只有 name。
   */
  function resolveToolLabel(name: string, rawArguments: string): string | undefined {
    const tools = ctx.get('tools') as
      | { get?: (name: string, scope?: unknown) => unknown }
      | undefined
    const get = tools?.get
    if (typeof get !== 'function') return undefined
    try {
      const def = get.call(tools, name) as
        | { presentCall?: (args: unknown) => unknown }
        | undefined
      const present = def?.presentCall
      if (typeof present !== 'function') return undefined
      const args = rawArguments.length > 0 ? JSON.parse(rawArguments) : {}
      const view = present.call(def, args) as { title?: unknown } | undefined
      const title = view && typeof view.title === 'string' ? view.title : undefined
      if (title === undefined) logger.debug?.('tool label miss: %s', name)
      else logger.debug?.('tool label hit: %s -> %s', name, title)
      return title
    } catch (error) {
      logger.debug?.('tool label resolve failed for %s: %o', name, error)
      return undefined
    }
  }

  /**
   * `plan/mode` 事件只带 active;pending 在宿主投影里。
   * 复用 `ctx.sessionProjections.stateOf(session,'plan')`,拿不到就不补。
   */
  function resolvePlanPending(session: unknown): boolean | undefined {
    const projections = ctx.get('sessionProjections') as
      | { stateOf?: (session: unknown, key: string) => unknown }
      | undefined
    const stateOf = projections?.stateOf
    if (typeof stateOf !== 'function') return undefined
    try {
      const state = stateOf.call(projections, session, 'plan')
      if (isRecord(state) && typeof state.pending === 'boolean') {
        logger.debug?.('plan pending from projection: %s', String(state.pending))
        return state.pending
      }
    } catch (error) {
      logger.debug?.('plan projection read failed: %o', error)
    }
    return undefined
  }

  const onSessionEvent = (session: unknown, event: unknown): void => {
    const sessionId = isRecord(session) && typeof session.id === 'string' ? session.id : undefined
    if (!sessionId) return
    const live = active.get(sessionId)
    if (!live) return

    const payloads = mapSessionEvent(event as SessionEventLike)
    if (payloads.length === 0) return

    for (const payload of payloads) {
      // 流式增量(chunk / reasoning-chunk)仅在客户端要求时转发
      if ((payload.kind === 'assistant.chunk' || payload.kind === 'assistant.reasoning-chunk') && !live.chunks) {
        continue
      }

      // 工具调用补人类可读标签
      if (payload.kind === 'tool.call') {
        const label = resolveToolLabel(
          typeof payload.name === 'string' ? payload.name : '',
          typeof payload.arguments === 'string' ? payload.arguments : '',
        )
        if (label !== undefined) payload.label = label
      }

      // plan 补 pending(宿主投影可得时)
      if (payload.kind === 'session.plan') {
        const pending = resolvePlanPending(session)
        if (pending !== undefined) payload.pending = pending
      }

      // 末条 assistant 文本计入索引预览,并记进内存历史
      if (payload.kind === 'assistant.message' && typeof payload.text === 'string') {
        index.touch(sessionId, { lastMessage: payload.text, messageDelta: 1 })
        pushMessage(live.messages, {
          role: 'assistant',
          text: payload.text,
          ts: Date.now(),
          kind: 'assistant.message',
        })
      }

      logger.debug?.('publish %s -> session:%s', String(payload.kind), sessionId)
      hub.publish(sessionTopic(sessionId), payload as unknown as JsonValue)
    }
  }

  const onAgentStatus = (arg: unknown): void => {
    const info = isRecord(arg) ? arg : {}
    const agent = isRecord(info.agent) ? info.agent : undefined
    const sessionId = agent && typeof agent.id === 'string' ? agent.id : undefined
    if (!sessionId || !active.has(sessionId)) return
    const status = typeof info.status === 'string' ? info.status : 'unknown'
    logger.debug?.('publish agent.status=%s -> session:%s', status, sessionId)
    hub.publish(sessionTopic(sessionId), {
      kind: 'agent.status',
      status,
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
    logger.warn('agent error for session %s: %s', sessionId, message)
    hub.publish(sessionTopic(sessionId), { kind: 'agent.error', message } as unknown as JsonValue)
  }

  ctx.on('session/event', onSessionEvent)
  ctx.on('agent/status', onAgentStatus)
  ctx.on('agent/error', onAgentError)

  // ── 审批桥接:answerer 挂起等客户端回复 ─────────────────────────────────────

  function cancelPendingApprovals(sessionId: string): void {
    for (const [pendingId, pending] of pendingApprovals) {
      if (pending.sessionId === sessionId) {
        logger.info('approval cancelled (session releasing): %s pendingId=%s', sessionId, pendingId)
        pending.settle('cancelled')
      }
    }
  }

  function respondApproval(sessionId: string, pendingId: string, allow: boolean): boolean {
    const pending = pendingApprovals.get(pendingId)
    if (!pending || pending.sessionId !== sessionId) {
      logger.debug?.('approval respond miss: %s pendingId=%s', sessionId, pendingId)
      return false
    }
    logger.info('approval responded: %s pendingId=%s allow=%s', sessionId, pendingId, String(allow))
    pending.settle(allow ? 'allowed-once' : 'rejected')
    return true
  }

  /**
   * 全局 answerer:对「我们管理的 agent」认领审批、推给客户端并等待;
   * 其它 agent 的审批调 next() 委托给后续 answerer(如 web UI)。
   */
  const onApprovalRequest = (...args: unknown[]): unknown => {
    const raw = args[0]
    const next = args[1] as (() => Promise<ApprovalOutcome>) | undefined
    const req = raw as ApprovalRequestLike
    const agentId = req?.agent && typeof req.agent.id === 'string' ? req.agent.id : undefined
    const live = agentId === undefined ? undefined : active.get(agentId)
    if (!live) {
      logger.debug?.('approval delegated to next answerer (not our agent): %s', String(agentId))
      return next ? next() : Promise.resolve<ApprovalOutcome>('unavailable')
    }
    const sessionId = agentId!
    const toolName = typeof req.toolName === 'string' ? req.toolName : '(unknown)'
    const pendingId = `approve-${randomUUID()}`
    logger.info('approval requested: %s tool=%s pendingId=%s', sessionId, toolName, pendingId)

    return new Promise<ApprovalOutcome>((resolve) => {
      let settled = false
      const settle = (outcome: ApprovalOutcome): void => {
        if (settled) return
        settled = true
        const pending = pendingApprovals.get(pendingId)
        if (pending) {
          clearTimeout(pending.timer)
          if (pending.signal && pending.onAbort) {
            pending.signal.removeEventListener?.('abort', pending.onAbort)
          }
          pendingApprovals.delete(pendingId)
        }
        logger.info('approval settled: %s tool=%s outcome=%s', sessionId, toolName, outcome)
        resolve(outcome)
      }

      const timer = setTimeout(() => {
        logger.warn('approval timeout (%dms): %s tool=%s -> rejected', options.approvalTimeoutMs, sessionId, toolName)
        settle('rejected')
      }, options.approvalTimeoutMs)
      timer.unref?.()

      const signal = req?.signal && typeof req.signal.addEventListener === 'function' ? req.signal : undefined
      const onAbort = (): void => {
        logger.info('approval aborted by host: %s tool=%s -> cancelled', sessionId, toolName)
        settle('cancelled')
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })

      pendingApprovals.set(pendingId, { sessionId, settle, timer, onAbort, signal })

      const payload: Record<string, unknown> = { kind: 'session.approval', pendingId, toolName }
      if (typeof req.callId === 'string') payload.callId = req.callId
      if (typeof req.reason === 'string') payload.reason = req.reason
      logger.debug?.('approval publish: %s kind=session.approval pendingId=%s', sessionId, pendingId)
      hub.publish(sessionTopic(sessionId), payload as unknown as JsonValue)
    })
  }

  ctx.on('approval/request', onApprovalRequest)

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

  async function open(sessionId: string, cwd?: string): Promise<LiveSession> {
    const existing = active.get(sessionId)
    if (existing) {
      logger.debug?.('session reuse (already live): %s', sessionId)
      return existing
    }

    const effectiveCwd = cwd ?? options.cwd
    const input = { sessionId, provider: options.provider, model: options.model, cwd: effectiveCwd }
    let handle: AgentTaskHandle
    let resumed = false
    // 会话在宿主侧是否存在 → 决定 resume 还是 create。
    // 宿主存在性(probeSession)比索引更权威:对已持久化但非 live 的 id 直接
    // create 会在首次 flush/dispose 异步报 "already has a persisted log on disk"。
    let known: boolean
    if (options.probeSession) {
      try {
        known = await options.probeSession(sessionId)
      } catch (error) {
        logger.warn('probe session %s failed, assuming not persisted: %o', sessionId, error)
        known = false
      }
    } else {
      known = index.get(sessionId) !== undefined
    }
    logger.info(
      'session open: %s (persisted=%s cwd=%s)',
      sessionId,
      String(known),
      effectiveCwd ?? '(none)',
    )
    if (known) {
      try {
        handle = await adapter.resume(input)
        resumed = true
        logger.info('session resumed: %s', sessionId)
      } catch (error) {
        logger.warn('resume session %s failed, falling back to create: %o', sessionId, error)
        handle = await adapter.create(input)
        try {
          await persistNewSession(sessionId, handle.agent)
        } catch (persistError) {
          await handle.dispose()
          throw persistError
        }
        logger.info('session created (after resume failure): %s', sessionId)
      }
    } else {
      handle = await adapter.create(input)
      // agents.create 只发布 live session；显式 flush 才会让 session-query
      // 与 PC Web UI 立即看到这个新会话。没有该宿主能力时保留兼容降级。
      try {
        await persistNewSession(sessionId, handle.agent)
      } catch (persistError) {
        await handle.dispose()
        throw persistError
      }
      if (effectiveCwd === undefined) {
        logger.info(
          'session %s has no cwd — it will land in the host "%s" bucket and cannot join any workspace',
          sessionId,
          '_no-cwd',
        )
      }
      index.upsert(sessionId)
      logger.info('session created: %s', sessionId)
    }

    // resume 起来的会话:把宿主持久化历史载入内存,
    // 否则恢复后的 history 只会有 resume 之后的新消息
    let messages: WireMessage[] = []
    if (resumed && options.loadHistory) {
      try {
        messages = await options.loadHistory(sessionId)
        logger.info('history preloaded for resumed session %s: %d messages', sessionId, messages.length)
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
    logger.debug?.('session live map size=%d', active.size)
    return live
  }

  async function persistNewSession(sessionId: string, agent: AgentTaskHandle['agent']): Promise<void> {
    const sessions = ctx.get('sessions') as { flush?: (session: unknown) => Promise<unknown> } | undefined
    if (typeof sessions?.flush !== 'function' || agent.session === undefined) {
      logger.warn('session %s created without persistence service/session handle', sessionId)
      return
    }
    const persisted = await sessions.flush.call(sessions, agent.session)
    if (persisted === false) {
      throw new Error(`宿主未持久化会话 ${sessionId}`)
    }
    logger.info('session persisted: %s', sessionId)
  }

  async function release(sessionId: string): Promise<void> {
    const live = active.get(sessionId)
    if (!live) {
      logger.debug?.('release ignored: session %s is not live', sessionId)
      return
    }
    active.delete(sessionId)
    clearIdle(live)
    // 会话即将销毁:未决的审批一律取消,别让 answerer 永久挂起
    cancelPendingApprovals(sessionId)
    try {
      await live.handle.dispose()
      logger.info('session released: %s (live remaining=%d)', sessionId, active.size)
    } catch (error) {
      logger.warn('dispose session %s failed: %o', sessionId, error)
    }
  }

  // ── 发送(串行) ───────────────────────────────────────────────────────────

  async function runTurn(live: LiveSession, prompt: string): Promise<SendResult> {
    const startedAt = Date.now()
    live.status = 'running'
    live.lastError = undefined
    logger.info('turn start: %s (promptLen=%d chunks=%s)', live.sessionId, prompt.length, String(live.chunks))
    pushMessage(live.messages, { role: 'user', text: prompt, ts: startedAt, kind: 'session.user-message' })
    hub.publish(sessionTopic(live.sessionId), userMessagePayload(prompt) as unknown as JsonValue)

    try {
      live.handle.agent.followup(buildUserMessage(prompt))
    } catch (error) {
      live.status = 'idle'
      logger.error('followup failed for session %s: %o', live.sessionId, error)
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
    const durationMs = Date.now() - startedAt
    logger.info(
      'turn end: %s status=%s durationMs=%d messages=%d',
      live.sessionId,
      status,
      durationMs,
      live.messages.length,
    )
    return {
      sessionId: live.sessionId,
      status,
      durationMs,
      ...(live.lastError === undefined ? {} : { error: live.lastError }),
    }
  }

  async function send(sessionId: string, prompt: string, sendOptions: SessionSendOptions = {}): Promise<SendResult> {
    const live = await open(sessionId)
    live.chunks = sendOptions.chunks === true
    clearIdle(live) // 执行期间不回收
    index.touch(sessionId, { lastMessage: prompt, messageDelta: 1 })
    logger.debug?.('send queued: %s (queue pending=%s)', sessionId, String(live.status === 'running'))

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
    if (!live) {
      logger.info('stop ignored: session %s is not live', sessionId)
      return false
    }
    try {
      live.handle.agent.cancel?.({ kind: 'user' })
      logger.info('session stopped (current turn only): %s', sessionId)
      return true
    } catch (error) {
      logger.warn('cancel session %s failed: %o', sessionId, error)
      return false
    }
  }

  async function ensure(sessionId: string, cwd?: string): Promise<void> {
    await open(sessionId, cwd)
  }

  return {
    ensure,

    send,

    stop,

    release,

    history(sessionId) {
      const live = active.get(sessionId)
      logger.debug?.('history requested: %s (live=%s)', sessionId, String(live !== undefined))
      return live ? [...live.messages] : undefined
    },

    liveIds() {
      return [...active.keys()]
    },

    respondApproval,

    async disposeAll() {
      disposed = true
      logger.info('session registry disposing: live=%d pendingApprovals=%d', active.size, pendingApprovals.size)
      ctx.off('session/event', onSessionEvent)
      ctx.off('agent/status', onAgentStatus)
      ctx.off('agent/error', onAgentError)
      ctx.off('approval/request', onApprovalRequest)
      // 未决审批一律取消,避免 answerer 挂起阻塞卸载
      for (const [pendingId, pending] of [...pendingApprovals]) {
        logger.info('approval cancelled (dispose): %s pendingId=%s', pending.sessionId, pendingId)
        pending.settle('cancelled')
      }
      await Promise.all([...active.keys()].map((id) => release(id)))
      logger.info('session registry disposed: live=%d pendingApprovals=%d', active.size, pendingApprovals.size)
    },
  }
}

/**
 * 会话接收码:session.create / list / get / history / send / stop / delete。
 *
 * 职责边界:
 *  - 索引(session-index)负责元数据与列表;
 *  - 注册表(session-registry)负责常驻 agent、发消息、回收;
 *  - 本模块只做参数校验、调两者、组装 res,并把失败映射成稳定错误码。
 *
 * 会话的「真相」在宿主 session;本插件的 SQLite 只是客户端侧索引。
 * 删除是**软删**(宿主没有公开的会话删除 API)。
 */

import { TaskError, type Hub, type LoggerLike, type RecvCtx } from '../hub/hub.js'
import { ErrorCodes, sessionTopic, type JsonValue } from '../protocol/frame.js'
import { newSessionId, type HostCtx } from '../bridge/agent-bridge.js'
import type { SessionIndex } from '../sessions/session-index.js'
import type { SessionRegistry, WireMessage } from '../sessions/session-registry.js'
import { readPersistedHistory } from '../sessions/persisted-history.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface RegisterSessionTaskDeps {
  host: HostCtx
  hub: Hub
  logger: LoggerLike
  index: SessionIndex
  registry: SessionRegistry
}

/** 注册全部会话接收码;返回注销函数。 */
export function registerSessionTask(deps: RegisterSessionTaskDeps): () => void {
  const { host, hub, logger, index, registry } = deps

  function requireSessionId(payload: JsonValue | undefined): string {
    if (!isRecord(payload) || typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
      throw new TaskError(ErrorCodes.BAD_REQUEST, 'payload.sessionId (non-empty string) is required')
    }
    return payload.sessionId
  }

  async function create(payload: JsonValue | undefined, recvCtx: RecvCtx): Promise<unknown> {
    const title = isRecord(payload) && typeof payload.title === 'string' ? payload.title : undefined
    const sessionId = newSessionId()
    const summary = index.upsert(sessionId, title === undefined ? {} : { title })
    // 与 agent.run 一致:把发起连接自动加入本会话主题,客户端无需手动 sub
    recvCtx.subscribe(sessionTopic(sessionId))
    // 立即拉起 agent(常驻);失败则回滚索引,避免留下无法使用的会话
    try {
      await registry.ensure(sessionId)
    } catch (error) {
      index.softDelete(sessionId)
      recvCtx.unsubscribe(sessionTopic(sessionId))
      throw new TaskError(ErrorCodes.AGENT_FAILED, errorMessage(error))
    }
    return { sessionId, title: summary.title, createdAt: summary.createdAt }
  }

  async function list(payload: JsonValue | undefined): Promise<unknown> {
    const options = isRecord(payload) ? payload : {}
    const limit = typeof options.limit === 'number' ? options.limit : 50
    const offset = typeof options.offset === 'number' ? options.offset : 0
    const includeDeleted = options.includeDeleted === true
    const sessions = index.list({ limit, offset, includeDeleted })
    // 标注哪些会话当前有常驻 agent
    const live = new Set(registry.liveIds())
    return {
      sessions: sessions.map((s) => ({ ...s, live: live.has(s.sessionId) })),
    }
  }

  async function get(payload: JsonValue | undefined): Promise<unknown> {
    const sessionId = requireSessionId(payload)
    const summary = index.get(sessionId)
    if (!summary) throw new TaskError(ErrorCodes.SESSION_NOT_FOUND, `session "${sessionId}" not found`)
    return { ...summary, live: registry.liveIds().includes(sessionId) }
  }

  async function history(payload: JsonValue | undefined): Promise<unknown> {
    const sessionId = requireSessionId(payload)
    const limit = isRecord(payload) && typeof payload.limit === 'number' ? payload.limit : 100
    // 活跃会话用内存历史(宿主落盘有延迟);否则读宿主持久化日志
    const inMemory = registry.history(sessionId)
    const messages = inMemory ?? (await readPersistedHistory(host, sessionId, limit))
    return { sessionId, messages: limit > 0 ? messages.slice(-limit) : messages }
  }

  async function send(payload: JsonValue | undefined, recvCtx: RecvCtx): Promise<unknown> {
    const sessionId = requireSessionId(payload)
    if (!isRecord(payload) || typeof payload.prompt !== 'string' || payload.prompt.length === 0) {
      throw new TaskError(ErrorCodes.BAD_REQUEST, 'payload.prompt (non-empty string) is required')
    }
    if (!index.get(sessionId)) {
      throw new TaskError(ErrorCodes.SESSION_NOT_FOUND, `session "${sessionId}" not found`)
    }
    // 与 create/agent.run 一致:发起操作的连接自动加入本会话主题。
    // 缺了这步,重连后对**已有**会话发消息会收不到任何事件 —— agent 照常执行,
    // 客户端却永远停在"运行中"(实机踩过)。
    recvCtx.subscribe(sessionTopic(sessionId))
    const chunks = payload.chunks === true
    try {
      return await registry.send(sessionId, payload.prompt, { chunks })
    } catch (error) {
      logger.error('session.send %s failed: %o', sessionId, error)
      const message = errorMessage(error)
      // 会话在索引里但宿主侧拿不到(从未落盘/已删)→ 用 resume 失败语义统一上报
      if (/resume|not found|no such|does not exist/i.test(message)) {
        throw new TaskError(ErrorCodes.SESSION_RESUME_FAILED, message)
      }
      throw new TaskError(ErrorCodes.AGENT_FAILED, message)
    }
  }

  async function stop(payload: JsonValue | undefined): Promise<unknown> {
    const sessionId = requireSessionId(payload)
    if (!index.get(sessionId)) {
      throw new TaskError(ErrorCodes.SESSION_NOT_FOUND, `session "${sessionId}" not found`)
    }
    const stopped = registry.stop(sessionId)
    return { sessionId, status: stopped ? 'stopped' : 'idle' }
  }

  async function remove(payload: JsonValue | undefined): Promise<unknown> {
    const sessionId = requireSessionId(payload)
    if (!index.get(sessionId)) {
      throw new TaskError(ErrorCodes.SESSION_NOT_FOUND, `session "${sessionId}" not found`)
    }
    // 先释放常驻 agent,再软删索引(宿主 jsonl 保留 —— 无公开删除 API)
    await registry.release(sessionId)
    index.softDelete(sessionId)
    return { sessionId, deleted: true }
  }

  const disposers: (() => void)[] = [
    hub.registerReceiver('session.create', create),
    hub.registerReceiver('session.list', list),
    hub.registerReceiver('session.get', get),
    hub.registerReceiver('session.history', history),
    hub.registerReceiver('session.send', send),
    hub.registerReceiver('session.stop', stop),
    hub.registerReceiver('session.delete', remove),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

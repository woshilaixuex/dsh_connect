/**
 * 会话接收码:session.create / list / get / history / send / stop / delete + workspace.list。
 *
 * 职责边界:
 *  - 索引(session-index)负责来源标记与元数据;
 *  - 注册表(session-registry)负责常驻 agent、发消息、回收;
 *  - 宿主读取(host-sessions)负责会话存在性/标题;
 *  - 镜像(session-mirror)负责把「宿主会话 ∪ 索引」合成客户端视图;
 *  - 本模块只做参数校验、编排、组装 res,并把失败映射成稳定错误码。
 *
 * 会话的「真相」在宿主 session;本插件 SQLite 只是客户端侧索引。
 * 删除是**软删**(宿主没有公开的会话删除 API)。
 */

import { randomUUID } from 'node:crypto'
import { TaskError, type Hub, type LoggerLike, type RecvCtx } from '../hub/hub.js'
import { ErrorCodes, sessionTopic, type JsonValue } from '../protocol/frame.js'
import type { HostCtx } from '../bridge/agent-bridge.js'
import {
  CLIENT_ID_PREFIX,
  type SessionIndex,
  type SessionSource,
} from '../sessions/session-index.js'
import type { SessionRegistry } from '../sessions/session-registry.js'
import { readPersistedHistory } from '../sessions/persisted-history.js'
import { listSessionRows, type SessionMirrorDeps } from '../sessions/session-mirror.js'
import type { HostSessionReader } from '../sessions/host-sessions.js'
import { listWorkspaces } from '../workspace/workspace-source.js'

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
  hostReader: HostSessionReader
}

/** 注册全部会话接收码;返回注销函数。 */
export function registerSessionTask(deps: RegisterSessionTaskDeps): () => void {
  const { host, hub, logger, index, registry, hostReader } = deps

  const mirrorDeps: SessionMirrorDeps = {
    listHostSessions: () => hostReader.list(),
    readTitles: (ids) => hostReader.titles(ids),
    index,
    logger,
  }

  function requireSessionId(payload: JsonValue | undefined): string {
    if (!isRecord(payload) || typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
      throw new TaskError(ErrorCodes.BAD_REQUEST, 'payload.sessionId (non-empty string) is required')
    }
    return payload.sessionId
  }

  /**
   * 新建或**复用**会话。
   *  - 传 `sessionId` 且宿主已有 → 复用(resume,上下文延续),source='host'
   *  - 传 `sessionId` 但宿主没有 → 用该 id 新建,source='client'
   *  - 不传 → 生成 `client-<uuid>`,source='client'
   */
  async function create(payload: JsonValue | undefined, recvCtx: RecvCtx): Promise<unknown> {
    const opts = isRecord(payload) ? payload : {}
    const requestedId =
      typeof opts.sessionId === 'string' && opts.sessionId.length > 0 ? opts.sessionId : undefined
    const title = typeof opts.title === 'string' && opts.title.length > 0 ? opts.title : undefined
    const cwd = typeof opts.cwd === 'string' && opts.cwd.length > 0 ? opts.cwd : undefined
    const sessionId = requestedId ?? `${CLIENT_ID_PREFIX}${randomUUID()}`

    // 先探宿主存在性,再登记索引(来源据此确定)
    const existedOnHost = await hostReader.exists(sessionId)
    const source: SessionSource = existedOnHost ? 'host' : 'client'
    index.upsert(sessionId, { source, ...(title === undefined ? {} : { title }) })
    logger.info(
      'session.create: id=%s source=%s reused=%s cwd=%s title=%s',
      sessionId,
      source,
      String(existedOnHost),
      cwd ?? '(none)',
      title ?? '(none)',
    )

    // 与 agent.run / session.send 一致:发起连接自动订阅本会话主题
    recvCtx.subscribe(sessionTopic(sessionId))
    try {
      await registry.ensure(sessionId, cwd)
    } catch (error) {
      logger.error('session.create failed for %s: %o', sessionId, error)
      index.softDelete(sessionId)
      recvCtx.unsubscribe(sessionTopic(sessionId))
      throw new TaskError(ErrorCodes.AGENT_FAILED, errorMessage(error))
    }

    const summary = index.get(sessionId)
    return {
      sessionId,
      source: summary?.source ?? source,
      reused: existedOnHost,
      ...(title === undefined ? {} : { title }),
    }
  }

  /** 会话列表:宿主已有会话 ∪ 本插件会话(含来源标记)。 */
  async function list(payload: JsonValue | undefined): Promise<unknown> {
    const opts = isRecord(payload) ? payload : {}
    const limit = typeof opts.limit === 'number' ? opts.limit : 50
    const offset = typeof opts.offset === 'number' ? opts.offset : 0
    const includeDeleted = opts.includeDeleted === true
    logger.debug?.('session.list: limit=%d offset=%d includeDeleted=%s', limit, offset, String(includeDeleted))

    const { rows } = await listSessionRows(mirrorDeps, { limit, offset, includeDeleted })
    const live = new Set(registry.liveIds())
    return {
      sessions: rows.map((row) => ({
        ...row,
        live: row.live || live.has(row.sessionId),
      })),
    }
  }

  /** 单个会话详情(宿主会话也可查)。 */
  async function get(payload: JsonValue | undefined): Promise<unknown> {
    const sessionId = requireSessionId(payload)
    const { rows } = await listSessionRows(mirrorDeps, { sessionId, includeDeleted: true, limit: 1 })
    const row = rows.find((item) => item.sessionId === sessionId)
    if (!row) throw new TaskError(ErrorCodes.SESSION_NOT_FOUND, `session "${sessionId}" not found`)
    return { ...row, live: row.live || registry.liveIds().includes(sessionId) }
  }

  /** 消息历史:活跃会话用内存,否则回退宿主持久化。 */
  async function history(payload: JsonValue | undefined): Promise<unknown> {
    const sessionId = requireSessionId(payload)
    const limit = isRecord(payload) && typeof payload.limit === 'number' ? payload.limit : 100
    const inMemory = registry.history(sessionId)
    const messages = inMemory ?? (await readPersistedHistory(host, sessionId, limit))
    logger.debug?.(
      'session.history: %s source=%s count=%d',
      sessionId,
      inMemory === undefined ? 'persisted' : 'memory',
      messages.length,
    )
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
    logger.info('session.send: %s (promptLen=%d chunks=%s)', sessionId, payload.prompt.length, String(chunks))
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
    logger.info('session.delete (soft): %s', sessionId)
    return { sessionId, deleted: true }
  }

  /** 工作区列表:registry 优先,cwd 兜底。 */
  async function workspaces(payload: JsonValue | undefined): Promise<unknown> {
    const opts = isRecord(payload) ? payload : {}
    const includeDeleted = opts.includeDeleted === true
    const { rows } = await listSessionRows(mirrorDeps, { includeDeleted, limit: 1000 })
    const result = listWorkspaces(host, rows, logger)
    return {
      source: result.source,
      workspaces: result.workspaces.map((ws) => ({
        ...ws,
        sessionIds: ws.sessionIds.filter((id) => rows.some((row) => row.sessionId === id)),
      })),
    }
  }

  /** 回复一个待决的审批请求(先到先得)。 */
  async function respondApproval(payload: JsonValue | undefined): Promise<unknown> {
    if (!isRecord(payload)) throw new TaskError(ErrorCodes.BAD_REQUEST, 'payload must be an object')
    const sessionId = requireSessionId(payload)
    if (typeof payload.pendingId !== 'string' || payload.pendingId.length === 0) {
      throw new TaskError(ErrorCodes.BAD_REQUEST, 'payload.pendingId (non-empty string) is required')
    }
    if (typeof payload.allow !== 'boolean') {
      throw new TaskError(ErrorCodes.BAD_REQUEST, 'payload.allow (boolean) is required')
    }
    const ok = registry.respondApproval(sessionId, payload.pendingId, payload.allow)
    if (!ok) {
      throw new TaskError(ErrorCodes.APPROVAL_NOT_FOUND, `approval "${payload.pendingId}" not found or session mismatch`)
    }
    logger.info('approval.respond: %s allow=%s', payload.pendingId, String(payload.allow))
    return { pendingId: payload.pendingId, outcome: payload.allow ? 'allowed-once' : 'rejected' }
  }

  const disposers: (() => void)[] = [
    hub.registerReceiver('session.create', create),
    hub.registerReceiver('session.list', list),
    hub.registerReceiver('session.get', get),
    hub.registerReceiver('session.history', history),
    hub.registerReceiver('session.send', send),
    hub.registerReceiver('session.stop', stop),
    hub.registerReceiver('session.delete', remove),
    hub.registerReceiver('workspace.list', workspaces),
    hub.registerReceiver('approval.respond', respondApproval),
  ]
  logger.info('session receivers registered: %d (+workspace.list, +approval.respond)', disposers.length)
  return () => {
    for (const dispose of disposers) dispose()
  }
}

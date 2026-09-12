/**
 * HTTP 只读接口的路由与响应组装(纯函数,不碰 socket)。
 *
 * 与 WS 的关系:HTTP 是**只读**的便捷入口(浏览器 fetch / 安卓 OkHttp / curl),
 * 写操作(发消息、建会话、删除)仍然走 WS,避免在 HTTP 上暴露破坏性接口。
 *
 * 数据一律复用既有模块:
 *  - 会话列表 → session-mirror 的 listSessionRows(宿主 ∪ 索引)
 *  - 工作区   → workspace-source 的 listWorkspaces(registry 优先,cwd 兜底)
 *  - 历史     → registry 内存(活跃)或 persisted-history(未激活)
 */

import type { HostCtx } from '../bridge/agent-bridge.js'
import type { LoggerLike } from '../hub/hub.js'
import type { SessionIndex } from '../sessions/session-index.js'
import type { SessionRegistry } from '../sessions/session-registry.js'
import type { HostSessionReader } from '../sessions/host-sessions.js'
import { listSessionRows, type SessionMirrorDeps } from '../sessions/session-mirror.js'
import { readPersistedHistory } from '../sessions/persisted-history.js'
import { listWorkspaces } from '../workspace/workspace-source.js'

/** 一次 HTTP 请求的最小输入(由 http-server 从 node req 提取)。 */
export interface RouteRequest {
  method: string
  /** 不含查询串的路径,例如 `/sessions/abc/history` */
  path: string
  query: URLSearchParams
}

/** 处理结果:状态码 + JSON 体(由 http-server 负责序列化与写头)。 */
export interface HttpResult {
  status: number
  body: unknown
}

export interface RouteDeps {
  host: HostCtx
  hostReader: HostSessionReader
  sessionIndex: SessionIndex
  /** 无宿主 agent 服务时为 undefined(历史回退到宿主持久化)。 */
  registry?: SessionRegistry
  logger: LoggerLike
  /** 进程启动时间,用于 /health 的 uptime。 */
  startedAt: number
}

/** 路由前缀常量。 */
export const ROUTES = {
  health: '/health',
  workspaces: '/workspaces',
  sessions: '/sessions',
} as const

/** 默认分页大小。 */
const DEFAULT_SESSION_LIMIT = 50
const DEFAULT_HISTORY_LIMIT = 100
/** 上限,防止一次拉爆内存/带宽。 */
const MAX_LIMIT = 1000

function badRequest(message: string): HttpResult {
  return { status: 400, body: { ok: false, code: 'bad.request', message, status: 400 } }
}

function notFound(message: string, code = 'not.found'): HttpResult {
  return { status: 404, body: { ok: false, code, message, status: 404 } }
}

function methodNotAllowed(method: string): HttpResult {
  return {
    status: 405,
    body: { ok: false, code: 'method.not.allowed', message: `method ${method} is not allowed (read-only GET API)`, status: 405 },
  }
}

function serverError(message: string): HttpResult {
  return { status: 500, body: { ok: false, code: 'internal', message, status: 500 } }
}

/** 解析非负整数查询参数;缺失返回 fallback,非法返回 undefined(调用方报 400)。 */
function parseCount(raw: string | null, fallback: number, max = MAX_LIMIT): number | undefined {
  if (raw === null || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) return undefined
  return Math.min(value, max)
}

/** 解析布尔查询参数:`1`/`true` 为真,其余为假。 */
function parseBool(raw: string | null): boolean {
  return raw === '1' || raw === 'true'
}

/** 会话历史的读取:活跃会话用内存,否则读宿主持久化。 */
async function readHistory(
  deps: RouteDeps,
  sessionId: string,
  limit: number,
): Promise<{ messages: unknown[]; source: 'memory' | 'persisted' }> {
  const inMemory = deps.registry?.history(sessionId)
  if (inMemory !== undefined) {
    return { messages: limit > 0 ? inMemory.slice(-limit) : inMemory, source: 'memory' }
  }
  const persisted = await readPersistedHistory(deps.host, sessionId, limit)
  return { messages: persisted, source: 'persisted' }
}

/**
 * 创建请求处理器。返回的函数是纯逻辑:给方法/路径/查询,回状态码与 JSON 体。
 */
export function createHandler(deps: RouteDeps): (req: RouteRequest) => Promise<HttpResult> {
  const mirrorDeps: SessionMirrorDeps = {
    listHostSessions: () => deps.hostReader.list(),
    readTitles: (ids) => deps.hostReader.titles(ids),
    index: deps.sessionIndex,
    logger: deps.logger,
  }

  /** 会话列表(宿主 ∪ 索引)。 */
  async function handleSessions(query: URLSearchParams): Promise<HttpResult> {
    const limit = parseCount(query.get('limit'), DEFAULT_SESSION_LIMIT)
    const offset = parseCount(query.get('offset'), 0)
    if (limit === undefined) return badRequest('`limit` must be a non-negative integer')
    if (offset === undefined) return badRequest('`offset` must be a non-negative integer')
    const includeDeleted = parseBool(query.get('includeDeleted'))

    const { rows, hostCount, indexCount } = await listSessionRows(mirrorDeps, {
      limit,
      offset,
      includeDeleted,
    })
    deps.logger.debug?.(
      'HTTP /sessions: limit=%d offset=%d includeDeleted=%s -> %d rows',
      limit,
      offset,
      String(includeDeleted),
      rows.length,
    )
    return {
      status: 200,
      body: {
        ok: true,
        sessions: rows,
        meta: { limit, offset, includeDeleted, hostCount, indexCount, returned: rows.length },
      },
    }
  }

  /** 工作区列表。 */
  async function handleWorkspaces(query: URLSearchParams): Promise<HttpResult> {
    const includeDeleted = parseBool(query.get('includeDeleted'))
    const { rows } = await listSessionRows(mirrorDeps, { includeDeleted, limit: MAX_LIMIT })
    const result = listWorkspaces(deps.host, rows, deps.logger)
    // 只保留仍可见的会话 id(默认已排除软删)
    const visible = new Set(rows.map((row) => row.sessionId))
    return {
      status: 200,
      body: {
        ok: true,
        source: result.source,
        workspaces: result.workspaces.map((ws) => ({
          ...ws,
          sessionIds: ws.sessionIds.filter((id) => visible.has(id)),
        })),
      },
    }
  }

  /** 单会话消息历史。 */
  async function handleHistory(sessionId: string, query: URLSearchParams): Promise<HttpResult> {
    const limit = parseCount(query.get('limit'), DEFAULT_HISTORY_LIMIT)
    if (limit === undefined) return badRequest('`limit` must be a non-negative integer')

    const { messages, source } = await readHistory(deps, sessionId, limit)
    deps.logger.debug?.('HTTP history %s: source=%s count=%d', sessionId, source, messages.length)
    return { status: 200, body: { ok: true, sessionId, source, messages } }
  }

  /** 健康检查 + 概览。降级也要回 200(健康检查不该因数据源抖动而 500)。 */
  async function handleHealth(): Promise<HttpResult> {
    let hostCount = 0
    let indexCount = 0
    let workspaceSource = 'unknown'
    let workspaceCount = 0
    const liveCount = deps.registry?.liveIds().length ?? 0
    try {
      const { rows, hostCount: hosts } = await listSessionRows(mirrorDeps, { limit: MAX_LIMIT })
      hostCount = hosts
      indexCount = deps.sessionIndex.listAll().length
      const ws = listWorkspaces(deps.host, rows, deps.logger)
      workspaceSource = ws.source
      workspaceCount = ws.workspaces.length
    } catch (error) {
      deps.logger.warn('HTTP /health degraded: %o', error)
    }
    return {
      status: 200,
      body: {
        ok: true,
        uptimeMs: Date.now() - deps.startedAt,
        sessions: { host: hostCount, index: indexCount, live: liveCount },
        workspaces: { source: workspaceSource, count: workspaceCount },
      },
    }
  }

  return async (req) => {
    // 只读接口:仅放行 GET / HEAD
    if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(req.method)

    try {
      // 容忍尾斜杠:`/sessions/` 与 `/sessions` 等价
      const path = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path
      const { query } = req

      if (path === ROUTES.health) return await handleHealth()
      if (path === ROUTES.workspaces) return await handleWorkspaces(query)
      if (path === ROUTES.sessions) return await handleSessions(query)

      // /sessions/:id/history —— 简单切分,不引路由库
      const segments = path.split('/').filter((s) => s.length > 0)
      if (segments.length === 3 && segments[0] === 'sessions' && segments[2] === 'history') {
        const sessionId = decodeURIComponent(segments[1]!)
        if (sessionId.length === 0) return badRequest('session id is required')
        return await handleHistory(sessionId, query)
      }

      deps.logger.debug?.('HTTP route miss: %s %s', req.method, req.path)
      return notFound(`no route for ${req.method} ${req.path}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      deps.logger.error('HTTP handler error: %o', error)
      return serverError(message)
    }
  }
}

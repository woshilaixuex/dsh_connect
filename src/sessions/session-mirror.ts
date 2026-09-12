/**
 * 会话镜像:把「宿主已有的会话」与「本插件索引」合成客户端视图。
 *
 * 为什么要合并:
 *  - 宿主(sessionQuery)知道会话的真相:header(cwd/createdAt/父会话)、live/persisted、标题;
 *    但**不知道**来源(client/host)、软删标记、最后消息预览、消息计数。
 *  - 本插件索引知道后一组,但不知道宿主会话全集。
 *
 * 合并规则:
 *  - `source`:索引里有 → 取索引值(索引是来源的权威);索引里没有 → `'host'`(宿主已有)。
 *  - `title`:索引标题优先,否则用宿主标题。
 *  - `updatedAt`:取索引活跃时间与宿主创建时间的较大者。
 *  - `deleted`:仅索引提供;默认过滤,`includeDeleted` 可见。
 */

import type { SessionIndex, SessionSummary, SessionSource } from './session-index.js'
import type { LoggerLike } from '../hub/hub.js'

/** 宿主会话记录(sessionQuery.listSessions() 的形状,结构类型)。 */
export interface HostSessionRecord {
  header: {
    id: string
    cwd?: string
    createdAt: number
    parentSession?: string
    origin?: string
  }
  live: boolean
  persisted: boolean
}

/** 合并后的客户端视图行。 */
export interface MirrorRow {
  sessionId: string
  source: SessionSource
  title?: string
  cwd?: string
  createdAt: number
  updatedAt: number
  live: boolean
  persisted: boolean
  messageCount?: number
  lastMessage?: string
  deleted?: boolean
}

/**
 * 纯合并:宿主记录 + 标题表 + 索引行 → 客户端视图行(未过滤、未分页,已按 updatedAt 倒序)。
 */
export function mergeSessionRows(
  hosts: readonly HostSessionRecord[],
  titles: ReadonlyMap<string, string>,
  indexRows: readonly SessionSummary[],
): MirrorRow[] {
  const rows = new Map<string, MirrorRow>()

  for (const host of hosts) {
    const header = host.header
    const title = titles.get(header.id)
    rows.set(header.id, {
      sessionId: header.id,
      source: 'host',
      ...(title === undefined ? {} : { title }),
      ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
      createdAt: header.createdAt,
      updatedAt: header.createdAt,
      live: host.live,
      persisted: host.persisted,
    })
  }

  for (const row of indexRows) {
    const existing = rows.get(row.sessionId)
    if (existing) {
      // 宿主有真相(创建时间/live/persisted/cwd),索引补元数据与来源
      rows.set(row.sessionId, {
        ...existing,
        source: row.source,
        ...(row.title === undefined ? {} : { title: row.title }),
        updatedAt: Math.max(existing.updatedAt, row.lastActiveAt),
        messageCount: row.messageCount,
        ...(row.lastMessage === undefined ? {} : { lastMessage: row.lastMessage }),
        ...(row.deleted === true ? { deleted: true } : {}),
      })
    } else {
      // 索引独有(理论上不该出现,但宿主 listing 失败时会退化到这里)
      rows.set(row.sessionId, {
        sessionId: row.sessionId,
        source: row.source,
        ...(row.title === undefined ? {} : { title: row.title }),
        createdAt: row.createdAt,
        updatedAt: row.lastActiveAt,
        live: false,
        persisted: false,
        messageCount: row.messageCount,
        ...(row.lastMessage === undefined ? {} : { lastMessage: row.lastMessage }),
        ...(row.deleted === true ? { deleted: true } : {}),
      })
    }
  }

  return [...rows.values()].sort((a, b) => b.updatedAt - a.updatedAt)
}

export interface SessionMirrorDeps {
  /** 读宿主会话全集(内部捕获异常并降级为空)。 */
  listHostSessions: () => Promise<HostSessionRecord[]>
  /** 批量读宿主标题。 */
  readTitles: (ids: readonly string[]) => Promise<Map<string, string>>
  index: SessionIndex
  logger?: LoggerLike
}

export interface ListOptions {
  limit?: number
  offset?: number
  includeDeleted?: boolean
  /** 只取这一个会话(session.get 用)。 */
  sessionId?: string
}

/**
 * 收集并合并(含 IO + 降级)。
 * 宿主 listing 失败时退化为「只用索引」,不整体失败。
 */
export async function listSessionRows(
  deps: SessionMirrorDeps,
  options: ListOptions = {},
): Promise<{ rows: MirrorRow[]; hostCount: number; indexCount: number }> {
  const { logger } = deps

  let hosts: HostSessionRecord[] = []
  try {
    hosts = await deps.listHostSessions()
  } catch (error) {
    logger?.warn('session mirror: host session listing failed, falling back to index only: %o', error)
  }

  let titles = new Map<string, string>()
  if (hosts.length > 0) {
    try {
      titles = await deps.readTitles(hosts.map((h) => h.header.id))
    } catch (error) {
      logger?.warn('session mirror: batch title read failed (continuing without titles): %o', error)
    }
  }

  const indexRows = deps.index.listAll()
  const merged = mergeSessionRows(hosts, titles, indexRows)

  const includeDeleted = options.includeDeleted === true
  let visible = includeDeleted ? merged : merged.filter((row) => row.deleted !== true)
  if (options.sessionId !== undefined) {
    visible = visible.filter((row) => row.sessionId === options.sessionId)
  }
  const limit = options.limit ?? 50
  const offset = options.offset ?? 0
  const rows = visible.slice(offset, offset + limit)

  logger?.info(
    'session mirror: host=%d index=%d merged=%d visible=%d returned=%d (includeDeleted=%s%s)',
    hosts.length,
    indexRows.length,
    merged.length,
    visible.length,
    rows.length,
    String(includeDeleted),
    options.sessionId === undefined ? '' : ` sessionId=${options.sessionId}`,
  )
  logger?.debug?.(
    'session mirror detail: titles=%d clients=%d hosts=%d deleted=%d',
    titles.size,
    merged.filter((r) => r.source === 'client').length,
    merged.filter((r) => r.source === 'host').length,
    merged.filter((r) => r.deleted === true).length,
  )

  return { rows, hostCount: hosts.length, indexCount: indexRows.length }
}

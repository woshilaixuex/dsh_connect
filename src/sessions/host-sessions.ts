/**
 * 宿主会话读取:本插件所有「问宿主要会话信息」的唯一入口。
 *
 * 集中在这里的原因:会话镜像(列表/标题)、`session.create` 的存在性探测、
 * 注册表的「该 resume 还是该 create」判定,都需要读宿主;散落各处容易走偏
 * (尤其 `agents.create` 对已持久化 id 会**异步**碰撞,必须靠 resume 优先规避)。
 *
 * 全部通过 `ctx.get()` 结构探测,不 import 宿主类型。
 */

import type { HostCtx } from '../bridge/agent-bridge.js'
import type { LoggerLike } from '../hub/hub.js'
import type { HostSessionRecord } from './session-mirror.js'

/** 批量读标题的上限(避免会话极多时打爆)。 */
const TITLE_READ_LIMIT = 100

interface SessionQueryLike {
  listSessions?: (signal?: AbortSignal) => Promise<unknown>
  readTitle?: (sessionId: string, signal?: AbortSignal) => Promise<unknown>
  observeSession?: (sessionId: string, options?: unknown) => Promise<unknown>
}

export interface HostSessionReader {
  /** 宿主会话全集(live + 冷持久化);宿主不可用时返回空数组。 */
  list(): Promise<HostSessionRecord[]>
  /** 批量标题(只读前 TITLE_READ_LIMIT 个)。读不到的 id 不出现在 map 里。 */
  titles(ids: readonly string[]): Promise<Map<string, string>>
  /** 该 id 在宿主侧是否存在(live 或已持久化)。 */
  exists(sessionId: string): Promise<boolean>
}

function sessionQueryOf(ctx: HostCtx): SessionQueryLike | undefined {
  const query = ctx.get('sessionQuery') as SessionQueryLike | undefined
  return query && typeof query === 'object' ? query : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createHostSessionReader(ctx: HostCtx, logger?: LoggerLike): HostSessionReader {
  async function list(): Promise<HostSessionRecord[]> {
    const query = sessionQueryOf(ctx)
    if (!query?.listSessions) {
      logger?.debug?.('host session reader: sessionQuery.listSessions unavailable')
      return []
    }
    const raw = await query.listSessions.call(query)
    if (!Array.isArray(raw)) return []

    const records: HostSessionRecord[] = []
    for (const item of raw) {
      if (!isRecord(item) || !isRecord(item.header)) continue
      const header = item.header
      if (typeof header.id !== 'string') continue
      if (typeof header.createdAt !== 'number') continue
      records.push({
        header: {
          id: header.id,
          createdAt: header.createdAt,
          ...(typeof header.cwd === 'string' ? { cwd: header.cwd } : {}),
          ...(typeof header.parentSession === 'string' ? { parentSession: header.parentSession } : {}),
          ...(typeof header.origin === 'string' ? { origin: header.origin } : {}),
        },
        live: item.live === true,
        persisted: item.persisted === true,
      })
    }
    logger?.debug?.('host session reader: listed %d host sessions', records.length)
    return records
  }

  async function titles(ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    const query = sessionQueryOf(ctx)
    if (!query?.readTitle || ids.length === 0) return out

    const targets = ids.slice(0, TITLE_READ_LIMIT)
    const results = await Promise.all(
      targets.map(async (id) => {
        try {
          const snapshot = await query.readTitle!.call(query, id)
          // SessionTitleSnapshot = { title, messageSeqs, source, eventSeq, updatedAt }
          if (isRecord(snapshot) && typeof snapshot.title === 'string' && snapshot.title.length > 0) {
            return [id, snapshot.title] as const
          }
        } catch (error) {
          logger?.debug?.('read title failed for %s: %o', id, error)
        }
        return undefined
      }),
    )
    for (const entry of results) {
      if (entry) out.set(entry[0], entry[1])
    }
    if (ids.length > TITLE_READ_LIMIT) {
      logger?.debug?.('title read capped at %d of %d sessions', TITLE_READ_LIMIT, ids.length)
    }
    return out
  }

  async function exists(sessionId: string): Promise<boolean> {
    const query = sessionQueryOf(ctx)
    if (!query?.observeSession) {
      // 没有 sessionQuery 时无从判断;保守返回 false(由 create 负责报错)
      logger?.debug?.('host session exists(%s): sessionQuery unavailable, assuming false', sessionId)
      return false
    }
    try {
      const lease = await query.observeSession.call(query, sessionId, { projectionMode: 'none' })
      // 观察租约是 caller-owned,用完必须释放
      const disposable = lease as { [Symbol.dispose]?: () => void } | undefined
      disposable?.[Symbol.dispose]?.()
      logger?.debug?.('host session exists(%s): true', sessionId)
      return true
    } catch {
      logger?.debug?.('host session exists(%s): false', sessionId)
      return false
    }
  }

  return { list, titles, exists }
}

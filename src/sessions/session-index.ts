/**
 * 会话索引(dsh-connect 侧元数据)。
 *
 * 会话的「真相」在宿主 session(jsonl 持久化);这里只存客户端查询用的元数据:
 * 标题、时间、最后消息预览、消息计数、软删标记。
 *
 * 删除是**软删**:宿主没有公开的会话删除 API,只能从本插件的列表里隐藏。
 */

import { migrate, type Migration } from '../store/store.js'
import type { DatabaseSync } from 'node:sqlite'
import type { LoggerLike } from '../hub/hub.js'

/**
 * 会话来源:
 *  - `client`:由本插件为远程客户端创建(前缀 `client-`)
 *  - `host`:宿主已有的会话(web UI 或其它入口建的)
 *
 * 宿主侧**没有**任何字段能标记这个(header.origin 只有 'subagent' 且是所有权判据),
 * 所以来源标记只能落在本插件的索引里。
 */
export type SessionSource = 'client' | 'host'

/** 判断一个会话 id 是否由本插件为客户端生成。 */
export function isClientSessionId(sessionId: string): boolean {
  return sessionId.startsWith(CLIENT_ID_PREFIX)
}

/** 客户端会话 id 前缀。 */
export const CLIENT_ID_PREFIX = 'client-'

/** 对外暴露的会话摘要(本插件索引侧)。 */
export interface SessionSummary {
  sessionId: string
  source: SessionSource
  title?: string
  createdAt: number
  lastActiveAt: number
  lastMessage?: string
  messageCount: number
  deleted?: boolean
}

/** 会话索引的存储接口(便于测试替身)。 */
export interface SessionIndex {
  /** 登记一个新会话(已存在则保留原 created_at/source,仅刷新活跃时间)。 */
  upsert(sessionId: string, init?: { title?: string; now?: number; source?: SessionSource }): SessionSummary
  /** 读单个会话;不存在返回 undefined。 */
  get(sessionId: string): SessionSummary | undefined
  /** 列出会话(newest-first;默认排除软删)。 */
  list(options?: { limit?: number; offset?: number; includeDeleted?: boolean }): SessionSummary[]
  /** 全部索引行(含软删、不截断)—— 供会话镜像合并用。 */
  listAll(): SessionSummary[]
  /** 刷新活跃时间,可选更新标题/最后消息/计数增量。 */
  touch(
    sessionId: string,
    patch?: { title?: string; lastMessage?: string; messageDelta?: number; now?: number },
  ): void
  /** 软删(标记 deleted_at);对未登记过的会话会先登记再标记。 */
  softDelete(sessionId: string, now?: number): boolean
  /** 是否存在(未软删)。 */
  has(sessionId: string): boolean
}

/** 索引表结构(顺序迁移)。 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up(db) {
      db.exec(`
        CREATE TABLE sessions (
          id             TEXT PRIMARY KEY,
          title          TEXT,
          created_at     INTEGER NOT NULL,
          last_active_at INTEGER NOT NULL,
          last_message   TEXT,
          message_count  INTEGER NOT NULL DEFAULT 0,
          deleted_at     INTEGER
        )
      `)
      db.exec('CREATE INDEX idx_sessions_last_active ON sessions (last_active_at DESC)')
    },
  },
  {
    // v2:来源标记。现有行都是本插件建的 → 回填 'client'。
    version: 2,
    up(db) {
      db.exec("ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'client'")
    },
  },
]

interface Row {
  id: string
  title: string | null
  created_at: number
  last_active_at: number
  last_message: string | null
  message_count: number
  deleted_at: number | null
  source: string
}

function toSummary(row: Row): SessionSummary {
  return {
    sessionId: row.id,
    source: row.source === 'host' ? 'host' : 'client',
    ...(row.title === null ? {} : { title: row.title }),
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    ...(row.last_message === null ? {} : { lastMessage: row.last_message }),
    messageCount: row.message_count,
    ...(row.deleted_at === null ? {} : { deleted: true }),
  }
}

/** 在给定数据库连接上建表并返回索引实现。 */
export function openSessionIndex(db: DatabaseSync, logger?: LoggerLike): SessionIndex {
  const version = migrate(db, MIGRATIONS)
  logger?.debug?.('session index ready: schema_version=%d', version)

  // 内部函数而非 this 方法:索引对象被解构传递时不能让接收者丢失
  function get(sessionId: string): SessionSummary | undefined {
    const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Row | undefined
    return row ? toSummary(row) : undefined
  }

  return {
    upsert(sessionId, init) {
      const now = init?.now ?? Date.now()
      const source: SessionSource = init?.source ?? (isClientSessionId(sessionId) ? 'client' : 'host')
      db.prepare(`
        INSERT INTO sessions (id, title, created_at, last_active_at, message_count, source)
        VALUES (?, ?, ?, ?, 0, ?)
        ON CONFLICT(id) DO UPDATE SET
          last_active_at = excluded.last_active_at,
          deleted_at = NULL,
          title = COALESCE(excluded.title, sessions.title)
      `).run(sessionId, init?.title ?? null, now, now, source)
      return get(sessionId)!
    },

    get,

    list(options = {}) {
      const limit = options.limit ?? 50
      const offset = options.offset ?? 0
      const where = options.includeDeleted ? '' : 'WHERE deleted_at IS NULL'
      const rows = db
        .prepare(`SELECT * FROM sessions ${where} ORDER BY last_active_at DESC LIMIT ? OFFSET ?`)
        .all(limit, offset) as unknown as Row[]
      return rows.map(toSummary)
    },

    listAll() {
      const rows = db
        .prepare('SELECT * FROM sessions ORDER BY last_active_at DESC')
        .all() as unknown as Row[]
      return rows.map(toSummary)
    },

    touch(sessionId, patch = {}) {
      const now = patch.now ?? Date.now()
      // COALESCE 让未提供的字段保持原值;last_message 允许显式覆盖
      db.prepare(`
        UPDATE sessions SET
          last_active_at = ?,
          title = COALESCE(?, title),
          last_message = COALESCE(?, last_message),
          message_count = message_count + ?
        WHERE id = ?
      `).run(now, patch.title ?? null, patch.lastMessage ?? null, patch.messageDelta ?? 0, sessionId)
    },

    softDelete(sessionId, now = Date.now()) {
      // 宿主会话可能从未登记过索引;先补一行(source 按 id 前缀判定),再标记
      db.prepare(`
        INSERT INTO sessions (id, created_at, last_active_at, message_count, source)
        VALUES (?, ?, ?, 0, ?)
        ON CONFLICT(id) DO NOTHING
      `).run(sessionId, now, now, isClientSessionId(sessionId) ? 'client' : 'host')
      const result = db
        .prepare('UPDATE sessions SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
        .run(now, sessionId)
      return result.changes > 0
    },

    has(sessionId) {
      const row = db
        .prepare('SELECT 1 AS ok FROM sessions WHERE id = ? AND deleted_at IS NULL')
        .get(sessionId) as { ok: number } | undefined
      return row !== undefined
    },
  }
}

/**
 * 内存索引:dbPath 被禁用时的兜底。
 * 会话真相仍在宿主;这里只是重启即丢的临时列表。
 */
export function createMemorySessionIndex(): SessionIndex {
  const rows = new Map<string, SessionSummary>()

  return {
    upsert(sessionId, init) {
      const now = init?.now ?? Date.now()
      const existing = rows.get(sessionId)
      const source: SessionSource =
        existing?.source ?? init?.source ?? (isClientSessionId(sessionId) ? 'client' : 'host')
      const summary: SessionSummary = existing
        ? {
            ...existing,
            lastActiveAt: now,
            deleted: undefined,
            ...(init?.title === undefined ? {} : { title: init.title }),
          }
        : {
            sessionId,
            source,
            createdAt: now,
            lastActiveAt: now,
            messageCount: 0,
            ...(init?.title === undefined ? {} : { title: init.title }),
          }
      rows.set(sessionId, summary)
      return { ...summary }
    },

    get(sessionId) {
      const row = rows.get(sessionId)
      return row ? { ...row } : undefined
    },

    list(options = {}) {
      const limit = options.limit ?? 50
      const offset = options.offset ?? 0
      const all = [...rows.values()]
        .filter((row) => options.includeDeleted === true || row.deleted !== true)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
      return all.slice(offset, offset + limit).map((row) => ({ ...row }))
    },

    listAll() {
      return [...rows.values()].sort((a, b) => b.lastActiveAt - a.lastActiveAt).map((row) => ({ ...row }))
    },

    touch(sessionId, patch = {}) {
      const row = rows.get(sessionId)
      if (!row) return
      const now = patch.now ?? Date.now()
      rows.set(sessionId, {
        ...row,
        lastActiveAt: now,
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.lastMessage === undefined ? {} : { lastMessage: patch.lastMessage }),
        messageCount: row.messageCount + (patch.messageDelta ?? 0),
      })
    },

    softDelete(sessionId, now = Date.now()) {
      const row = rows.get(sessionId)
      if (!row) {
        // 宿主会话可能从未登记;补一行后再标记
        rows.set(sessionId, {
          sessionId,
          source: isClientSessionId(sessionId) ? 'client' : 'host',
          createdAt: now,
          lastActiveAt: now,
          messageCount: 0,
          deleted: true,
        })
        return true
      }
      if (row.deleted === true) return false
      rows.set(sessionId, { ...row, deleted: true, lastActiveAt: now })
      return true
    },

    has(sessionId) {
      const row = rows.get(sessionId)
      return row !== undefined && row.deleted !== true
    },
  }
}

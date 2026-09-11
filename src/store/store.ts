/**
 * SQLite 存储基座(基建层,业务表/迁移后续再补)。
 *
 * 选型:Node 22 内置 `node:sqlite`(DatabaseSync)——零新增依赖、无原生编译,
 * 与这台机器的 pnpm/npm 环境最稳;宿主 dsh 跑在同一 Node(≥22.5)即可用。
 *
 * 只提供三样基建能力:
 *  1. resolveDbPath:统一数据库文件定位(不依赖 process.cwd());
 *  2. openDatabase:打开 + 常用 PRAGMA(WAL/外键/忙等待超时)+ 幂等 dispose;
 *  3. 路径与生命周期语义与日志(logPath)保持一致。
 *
 * dbPath 语义:undefined = 默认位置(dsh home/dsh-connect/dsh-connect.db);
 * 空串 = 不启用(返回 undefined);相对路径基于 dsh home;绝对路径原样。
 */

import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

/** store 只依赖 ctx 取 dshHomePath,最小结构类型即可。 */
export interface StoreCtx {
  get(key: string): unknown
}

/** dsh home 下的默认数据库子目录(与 defaultLogDir 同风格)。 */
const DEFAULT_SUBDIR = join('dsh-connect', 'dsh-connect.db')

/** dsh home 目录解析:dshHomePath 优先,回退 os.homedir()/.dsh。 */
function homeBase(ctx: StoreCtx): string {
  const dshHomePath = ctx.get('dshHomePath') as ((...segments: string[]) => string) | undefined
  return dshHomePath
    ? dshHomePath('.')
    : join(homedir(), '.dsh')
}

/**
 * 把 dbPath 解析成数据库文件绝对路径。
 * @returns undefined = 不启用(空串);否则为绝对文件路径。
 */
export function resolveDbPath(ctx: StoreCtx, dbPath?: string): string | undefined {
  if (dbPath === '') return undefined
  if (dbPath === undefined) return join(homeBase(ctx), DEFAULT_SUBDIR)
  if (isAbsolute(dbPath)) return dbPath
  return resolve(homeBase(ctx), dbPath)
}

export interface DbHandle {
  /** 打开的 SQLite 连接(业务层直接用它建表/读写)。 */
  db: DatabaseSync
  /** 数据库文件绝对路径。 */
  path: string
  /** 关闭连接,幂等,不抛异常。 */
  dispose(): void
}

/** 一次 schema 迁移:版本号从 version-1 升到 version。 */
export interface Migration {
  version: number
  up(db: DatabaseSync): void
}

/**
 * 执行顺序迁移:把 schema_version 从当前值一路升到目标版本。
 *
 * - 版本存于 meta(key,value) 表(首次自动建);
 * - 只应用 version > 当前版本的迁移,按 version 升序;
 * - 每个迁移单独事务化,失败即中断并抛出(不留下半应用的 schema)。
 *
 * @returns 应用后的 schema 版本。
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[]): number {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const readVersion = (): number => {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined
    const parsed = row ? Number(row.value) : 0
    return Number.isFinite(parsed) ? parsed : 0
  }

  const pending = [...migrations].filter((m) => m.version > readVersion()).sort((a, b) => a.version - b.version)
  let current = readVersion()
  for (const migration of pending) {
    db.exec('BEGIN')
    try {
      migration.up(db)
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(migration.version))
      db.exec('COMMIT')
      current = migration.version
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  return current
}

/**
 * 打开数据库文件(自动建目录),应用基础 PRAGMA。
 * @param path resolveDbPath 的返回值;undefined 时不打开(直接抛错,调用方应先判空)。
 */
export function openDatabase(ctx: StoreCtx, path: string): DbHandle {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  // WAL:读写不互斥,便于未来长任务连接与读取并存
  db.exec('PRAGMA journal_mode = WAL')
  // 外键约束开启(业务表做关联时依赖)
  db.exec('PRAGMA foreign_keys = ON')
  // WAL 下多连接并发写时避免 SQLITE_BUSY
  db.exec('PRAGMA busy_timeout = 5000')

  let closed = false
  return {
    db,
    path,
    dispose: () => {
      if (closed) return
      closed = true
      try {
        db.close()
      } catch {
        // 关闭失败不扩散(进程退出路径上要兜得住)
      }
    },
  }
}

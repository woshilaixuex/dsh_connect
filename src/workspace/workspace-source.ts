/**
 * 工作区来源:优先复用宿主 `ctx.workspaceRegistry`,缺失时按会话 cwd 兜底分组。
 *
 * 背景:`@deepseek-ai/dsh-workspace` 只在 **web-app bundle** 里挂载;
 * base(以及 dev-connect = base + dsh-connect)默认**没有**这个服务。
 * 所以这里做特征探测:
 *  - registry 可用 → 用宿主工作区(含用户在 web 侧自定义的名称/顺序)
 *  - 不可用      → 按会话 header.cwd 分组合成(不依赖任何宿主配置,总能工作)
 *
 * 无论走哪条,返回值都带 `source` 字段,便于客户端与排查时区分。
 */

import { basename } from 'node:path'
import type { HostCtx } from '../bridge/agent-bridge.js'
import type { LoggerLike } from '../hub/hub.js'
import type { MirrorRow } from '../sessions/session-mirror.js'

/** 客户端看到的工作区。 */
export interface WorkspaceView {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
}

export type WorkspaceSourceKind = 'registry' | 'cwd'

export interface ListWorkspacesResult {
  workspaces: WorkspaceView[]
  source: WorkspaceSourceKind
}

/** 宿主 registry 里一个工作区的形状(结构类型,不 import 宿主包)。 */
interface RegistryWorkspaceLike {
  id?: unknown
  path?: unknown
  title?: unknown
  sessionIds?: unknown
}

/**
 * 读取工作区列表。
 * @param ctx 宿主 ctx(用于探测 workspaceRegistry)
 * @param rows 当前会话镜像行(用于 cwd 兜底分组)
 */
export function listWorkspaces(
  ctx: HostCtx,
  rows: readonly MirrorRow[],
  logger?: LoggerLike,
): ListWorkspacesResult {
  const fromRegistry = readRegistryWorkspaces(ctx)
  if (fromRegistry) {
    logger?.info('workspace source: registry (%d workspaces)', fromRegistry.length)
    for (const ws of fromRegistry) {
      logger?.debug?.('workspace(registry): %s sessions=%d path=%s', ws.workspaceId, ws.sessionIds.length, ws.path)
    }
    return { workspaces: fromRegistry, source: 'registry' }
  }

  const fromCwd = groupByCwd(rows)
  logger?.info(
    'workspace source: cwd fallback (workspaceRegistry unavailable, %d groups)',
    fromCwd.length,
  )
  for (const ws of fromCwd) {
    logger?.debug?.('workspace(cwd): %s sessions=%d', ws.path, ws.sessionIds.length)
  }
  return { workspaces: fromCwd, source: 'cwd' }
}

/** registry 可用时读取;不可用或形状不符时返回 undefined。 */
function readRegistryWorkspaces(ctx: HostCtx): WorkspaceView[] | undefined {
  const registry = ctx.get('workspaceRegistry') as { list?: () => unknown } | undefined
  const list = registry?.list
  if (typeof list !== 'function') return undefined

  let raw: unknown
  try {
    raw = list.call(registry)
  } catch {
    return undefined
  }
  if (!Array.isArray(raw)) return undefined

  const workspaces: WorkspaceView[] = []
  for (const item of raw as RegistryWorkspaceLike[]) {
    if (!item || typeof item !== 'object') continue
    const path = typeof item.path === 'string' ? item.path : undefined
    if (path === undefined) continue
    const id = typeof item.id === 'string' ? item.id : path
    const title = typeof item.title === 'string' && item.title.length > 0 ? item.title : basename(path)
    const sessionIds = Array.isArray(item.sessionIds)
      ? item.sessionIds.filter((v): v is string => typeof v === 'string')
      : []
    workspaces.push({ workspaceId: id, path, title, sessionIds: [...sessionIds] })
  }
  return workspaces
}

/** 按会话 cwd 分组;无 cwd 的会话不进任何工作区(宿主既有语义)。 */
function groupByCwd(rows: readonly MirrorRow[]): WorkspaceView[] {
  const groups = new Map<string, { title: string; sessionIds: string[] }>()
  for (const row of rows) {
    if (row.cwd === undefined || row.cwd.length === 0) continue
    const existing = groups.get(row.cwd)
    if (existing) {
      existing.sessionIds.push(row.sessionId)
    } else {
      groups.set(row.cwd, { title: basename(row.cwd), sessionIds: [row.sessionId] })
    }
  }
  return [...groups.entries()]
    .map(([path, group]) => ({ workspaceId: path, path, title: group.title, sessionIds: group.sessionIds }))
    .sort((a, b) => a.path.localeCompare(b.path))
}

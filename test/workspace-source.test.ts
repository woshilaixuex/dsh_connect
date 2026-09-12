import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { listWorkspaces } from '../src/workspace/workspace-source.js'
import type { MirrorRow } from '../src/sessions/session-mirror.js'
import type { HostCtx } from '../src/bridge/agent-bridge.js'
import { makeLogger } from './helpers.js'

function row(sessionId: string, cwd?: string): MirrorRow {
  return {
    sessionId,
    source: 'host',
    createdAt: 1000,
    updatedAt: 1000,
    live: false,
    persisted: true,
    ...(cwd === undefined ? {} : { cwd }),
  }
}

/** 假 ctx:workspaceRegistry 可注入。 */
function ctxWith(registry: unknown): HostCtx {
  return {
    get: (key: string) => (key === 'workspaceRegistry' ? registry : undefined),
    on: () => {},
    off: () => {},
  }
}

describe('listWorkspaces:registry 优先', () => {
  test('用宿主工作区(含用户自定义名称)', () => {
    const registry = {
      list: () => [
        { id: 'ws-1', path: 'D:/proj', title: '我的项目', sessionIds: ['h1', 'h2'] },
      ],
    }
    const result = listWorkspaces(ctxWith(registry), [row('h1', 'D:/proj')], makeLogger())
    assert.equal(result.source, 'registry')
    assert.equal(result.workspaces.length, 1)
    assert.deepEqual(result.workspaces[0], {
      workspaceId: 'ws-1',
      path: 'D:/proj',
      title: '我的项目',
      sessionIds: ['h1', 'h2'],
    })
  })

  test('title 缺失时回退 basename(path)', () => {
    const registry = { list: () => [{ id: 'ws-1', path: 'D:/a/b/proj', sessionIds: [] }] }
    const result = listWorkspaces(ctxWith(registry), [], makeLogger())
    assert.equal(result.workspaces[0]!.title, 'proj')
  })

  test('id 缺失时用 path 兜底', () => {
    const registry = { list: () => [{ path: 'D:/proj' }] }
    const result = listWorkspaces(ctxWith(registry), [], makeLogger())
    assert.equal(result.workspaces[0]!.workspaceId, 'D:/proj')
    assert.deepEqual(result.workspaces[0]!.sessionIds, [])
  })

  test('形状不符的条目被跳过(没有 path)', () => {
    const registry = { list: () => [{ id: 'x' }, null, 'str', { path: 'D:/ok' }] }
    const result = listWorkspaces(ctxWith(registry), [], makeLogger())
    assert.equal(result.workspaces.length, 1)
    assert.equal(result.workspaces[0]!.path, 'D:/ok')
  })
})

describe('listWorkspaces:cwd 兜底', () => {
  test('registry 缺失时按 cwd 分组', () => {
    const rows = [row('a', 'D:/proj'), row('b', 'D:/proj'), row('c', 'D:/other')]
    const result = listWorkspaces(ctxWith(undefined), rows, makeLogger())
    assert.equal(result.source, 'cwd')
    assert.deepEqual(
      result.workspaces.map((w) => [w.path, w.title, w.sessionIds.length]),
      [
        ['D:/other', 'other', 1],
        ['D:/proj', 'proj', 2],
      ],
    )
  })

  test('无 cwd 的会话不进任何工作区(宿主既有语义)', () => {
    const result = listWorkspaces(ctxWith(undefined), [row('a'), row('b', 'D:/p')], makeLogger())
    assert.equal(result.workspaces.length, 1)
    assert.deepEqual(result.workspaces[0]!.sessionIds, ['b'])
  })

  test('空 cwd 字符串也视为无 cwd', () => {
    const result = listWorkspaces(ctxWith(undefined), [row('a', '')], makeLogger())
    assert.deepEqual(result.workspaces, [])
  })

  test('registry.list 抛错 → 回退 cwd', () => {
    const registry = {
      list: () => {
        throw new Error('boom')
      },
    }
    const result = listWorkspaces(ctxWith(registry), [row('a', 'D:/p')], makeLogger())
    assert.equal(result.source, 'cwd')
    assert.equal(result.workspaces.length, 1)
  })

  test('registry.list 返回非数组 → 回退 cwd', () => {
    const result = listWorkspaces(ctxWith({ list: () => 'nope' }), [row('a', 'D:/p')], makeLogger())
    assert.equal(result.source, 'cwd')
  })

  test('registry 无 list 方法 → 回退 cwd', () => {
    const result = listWorkspaces(ctxWith({}), [row('a', 'D:/p')], makeLogger())
    assert.equal(result.source, 'cwd')
  })
})

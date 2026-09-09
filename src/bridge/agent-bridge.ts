/**
 * dsh 宿主桥接层:唯一接触宿主 ctx 服务的模块。
 *
 * 宿主类型包(@deepseek-ai/dsh-agent / dsh-session / dsh-llm)在插件 node_modules
 * 不可直接 import(仅在 .pnpm store,AGENTS.md 已记录),因此这里只做两件事:
 *  1. 运行时用 ctx.get() 探测宿主服务,提供统一出口 AgentRun.start。
 *  2. 用最小结构类型描述 agent 面,避免类型依赖与版本漂移。
 *
 * 已核实的真实 API(dsh-agent@0.0.1-rc.5 store 类型):
 *   ctx.agents.create({ sessionId, meta?, agentOptions?, setup?, signal? })
 *     → Promise<{ agent, dispose() }>
 *   agent.followup(userMessage) / agent.whenIdle() / agent.status / agent.cancel(cause)
 * 宿主运行时另暴露私有 agentLoop(AGENTS.md 实测存在),作为兜底路径。
 */

import { randomUUID } from 'node:crypto'

/** 插件对宿主 ctx 的最小依赖面。 */
export interface HostCtx {
  get(key: string): unknown
  on(event: string, handler: (...args: unknown[]) => void): void
  off(event: string, handler: (...args: unknown[]) => void): void
}

/** 结构化的宿主 agent 面(只取本插件用到的)。 */
export interface AgentLike {
  readonly id: string
  readonly status?: string
  followup(message: unknown): unknown
  whenIdle(): Promise<void>
  cancel?(cause?: { kind: 'user' }): void
}

export interface AgentTaskHandle {
  readonly agent: AgentLike
  /** 释放 agent(归属者 dispose),幂等,不抛异常。 */
  dispose(): Promise<void>
}

export interface StartInput {
  sessionId: string
  prompt: string
  cwd?: string
}

/** 宿主适配器:把「sessionId + prompt」变成可驱动的 AgentTaskHandle。 */
export interface AgentRunAdapter {
  readonly kind: 'agents' | 'agentLoop'
  start(input: StartInput): Promise<AgentTaskHandle>
}

/** 探测宿主适配器;两类服务都没有时返回 undefined(调用方回 host.unavailable)。 */
export function detectAgentAdapter(ctx: HostCtx): AgentRunAdapter | undefined {
  const agents = ctx.get('agents') as
    | { create?: (options: unknown) => unknown }
    | undefined
  const agentsCreate = agents?.create
  if (typeof agentsCreate === 'function') {
    return {
      kind: 'agents',
      async start(input) {
        const created = (await agentsCreate({
          sessionId: input.sessionId,
          meta: input.cwd ? { cwd: input.cwd } : undefined,
        })) as {
          agent: AgentLike
          dispose: () => unknown
        }
        return {
          agent: created.agent,
          dispose: async () => {
            await created.dispose?.()
          },
        }
      },
    }
  }

  const agentLoop = ctx.get('agentLoop') as
    | { create?: (id: string, options?: unknown, meta?: unknown) => unknown }
    | undefined
  const agentLoopCreate = agentLoop?.create
  if (typeof agentLoopCreate === 'function') {
    return {
      kind: 'agentLoop',
      async start(input) {
        const created = (await agentLoopCreate(input.sessionId, {}, input.cwd ? { cwd: input.cwd } : undefined)) as
          | AgentLike
          | { agent?: AgentLike }
        const agent = 'agent' in (created as object) ? (created as { agent: AgentLike }).agent : (created as AgentLike)
        return {
          agent,
          dispose: async () => {
            const handle = created as { dispose?: () => unknown }
            if (typeof handle.dispose === 'function') await handle.dispose()
            else if (typeof (agent as { dispose?: () => unknown }).dispose === 'function') {
              await (agent as { dispose?: () => unknown }).dispose?.()
            }
          },
        }
      },
    }
  }

  return undefined
}

/**
 * 构造一条 user 消息(按已核实的 dsh-llm Message 四字段形状):
 * { id, role: 'user', content: [text 块], source: { kind: 'user' } }。
 */
export function buildUserMessage(text: string): unknown {
  return {
    id: `msg-${randomUUID()}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** 生成远端任务/会话 id。 */
export function newSessionId(): string {
  return `remote-${randomUUID()}`
}

/**
 * dsh 宿主桥接层:唯一接触宿主 ctx 服务的模块。
 *
 * 宿主类型包(@deepseek-ai/dsh-agent / dsh-session / dsh-llm)在插件 node_modules
 * 不可直接 import(仅在 .pnpm store,AGENTS.md 已记录),因此这里只做两件事:
 *  1. 运行时用 ctx.get() 探测宿主服务,提供统一出口 create / resume。
 *  2. 用最小结构类型描述 agent 面,避免类型依赖与版本漂移。
 *
 * 已核实的真实 API(dsh-agent@0.0.1-rc.5 store 类型 + 实机):
 *   ctx.agents.create({ sessionId, meta?, agentOptions?, setup?, signal? })
 *     → Promise<{ agent, dispose() }>
 *   ctx.agents.resume({ resumeSessionId, agentOptions?, setup?, signal? })
 *     → Promise<{ agent, dispose() }>   // 从持久化会话恢复
 *   agent.followup(userMessage) / agent.whenIdle() / agent.status / agent.cancel(cause)
 * 宿主运行时另暴露私有 agentLoop(AGENTS.md 实测存在),作为兜底路径;
 * agentLoop 无公开 resume,恢复请求在其上会失败,调用方回退 create。
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

/** 打开(新建或恢复)一个 agent 的输入。 */
export interface OpenInput {
  sessionId: string
  cwd?: string
  /** 显式模型路由(插件配置);缺省时回退宿主默认模型。 */
  provider?: string
  model?: string
}

/** 宿主默认模型选择的形状(ctx.agentDefaultModel.currentSelection())。 */
export interface ModelSelectionLike {
  provider?: unknown
  model?: unknown
  reasoningEffort?: unknown
}

/** 宿主适配器:把 sessionId(+模型路由)变成可驱动的 AgentTaskHandle。 */
export interface AgentRunAdapter {
  readonly kind: 'agents' | 'agentLoop'
  /** 新建 agent + session。 */
  create(input: OpenInput): Promise<AgentTaskHandle>
  /** 从已持久化的会话恢复 agent;不支持/失败时抛错(调用方回退 create)。 */
  resume(input: OpenInput): Promise<AgentTaskHandle>
}

/**
 * 读取宿主默认模型路由(base bundle 的 @deepseek-ai/dsh-agent-default-model)。
 * 无该服务(或形状不符)时返回 undefined。
 */
export function resolveHostDefaultModel(ctx: HostCtx): ModelSelectionLike | undefined {
  const service = ctx.get('agentDefaultModel') as { currentSelection?: () => unknown } | undefined
  const currentSelection = service?.currentSelection
  if (typeof currentSelection !== 'function') return undefined
  try {
    // 保留接收者:宿主 Service 方法同样依赖 this
    const selection = currentSelection.call(service) as ModelSelectionLike | undefined
    if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
      return selection
    }
  } catch {
    // 形状不符交给 create 报错,这里只是尽力而为的兜底
  }
  return undefined
}

/**
 * 组装 create/resume 用的 AgentOptions:显式入参优先,其次宿主默认模型。
 * 两者都没有时返回 undefined(由宿主抛「has no provider/model」,错误会经事件回推)。
 */
function buildAgentOptions(ctx: HostCtx, input: OpenInput): Record<string, unknown> | undefined {
  if (input.provider && input.model) {
    return { provider: input.provider, model: input.model }
  }
  const fallback = resolveHostDefaultModel(ctx)
  if (!fallback) return undefined
  return {
    provider: fallback.provider,
    model: fallback.model,
    ...(fallback.reasoningEffort === undefined ? {} : { reasoningEffort: fallback.reasoningEffort }),
  }
}

/** 从宿主 create/resume 的返回值包装成 AgentTaskHandle。 */
function toHandle(created: unknown): AgentTaskHandle {
  const holder = created as { agent: AgentLike; dispose?: () => unknown }
  const agent = holder.agent
  return {
    agent,
    dispose: async () => {
      if (typeof holder.dispose === 'function') await holder.dispose()
      else if (typeof (agent as { dispose?: () => unknown }).dispose === 'function') {
        await (agent as { dispose?: () => unknown }).dispose?.()
      }
    },
  }
}

/** 探测宿主适配器;两类服务都没有时返回 undefined(调用方回 host.unavailable)。 */
export function detectAgentAdapter(ctx: HostCtx): AgentRunAdapter | undefined {
  // 注意:必须以服务对象为接收者调用——宿主实现内部依赖 this.ctx,
  // 解构出来裸调用会让 this 丢失(实机报 reading 'ctx' of undefined)。
  // 局部 const 接住函数是为了在闭包里保住类型收窄。
  const agents = ctx.get('agents') as
    | { create?: (options: unknown) => unknown; resume?: (options: unknown) => unknown }
    | undefined
  if (agents && typeof agents.create === 'function') {
    const create = agents.create
    const resume = agents.resume
    return {
      kind: 'agents',
      async create(input) {
        const created = await create.call(agents, {
          sessionId: input.sessionId,
          meta: input.cwd ? { cwd: input.cwd } : undefined,
          agentOptions: buildAgentOptions(ctx, input),
        })
        return toHandle(created)
      },
      async resume(input) {
        if (typeof resume !== 'function') throw new Error('host agents service has no resume()')
        const created = await resume.call(agents, {
          resumeSessionId: input.sessionId,
          agentOptions: buildAgentOptions(ctx, input),
        })
        return toHandle(created)
      },
    }
  }

  const agentLoop = ctx.get('agentLoop') as
    | { create?: (id: string, options?: unknown, meta?: unknown) => unknown }
    | undefined
  if (agentLoop && typeof agentLoop.create === 'function') {
    const create = agentLoop.create
    return {
      kind: 'agentLoop',
      async create(input) {
        const created = await create.call(
          agentLoop,
          input.sessionId,
          buildAgentOptions(ctx, input) ?? {},
          input.cwd ? { cwd: input.cwd } : undefined,
        )
        return toHandle(created)
      },
      async resume() {
        // agentLoop 是宿主私有兜底路径,没有公开的恢复能力
        throw new Error('agentLoop adapter does not support resume')
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

/** 生成会话 id(会话的真相是宿主 session)。 */
export function newSessionId(): string {
  return `sess-${randomUUID()}`
}

/** 生成一次性任务 id(agent.run 用)。 */
export function newTaskId(): string {
  return `remote-${randomUUID()}`
}

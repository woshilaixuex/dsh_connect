/**
 * dsh agent 任务:接收码 agent.run / agent.stop 的实现。
 *
 * agent.run 流程:
 *  1. 校验 payload(需要 prompt 文本),生成 taskId(= sessionId)。
 *  2. 通过宿主适配器(agents / agentLoop)拉起 agent。
 *  3. 把发起连接自动加入推送主题 task:<taskId>(规则统一:evt 只发给订阅者)。
 *  4. 挂全局宿主事件监听(session/event、agent/status、agent/error),按 id 过滤,
 *     经 event-map 映射后 publish 到任务主题。
 *  5. followup(user message) → whenIdle() 等静默 → teardown(注销监听、退订、dispose)。
 *
 * 连接断开时,任务表按 connId 取消并清理所有归属任务(dispose agent)。
 */

import { TaskError, type ConnectionHandle, type Hub, type LoggerLike, type RecvCtx } from '../hub/hub.js'
import { ErrorCodes, taskTopic, type JsonValue } from '../protocol/frame.js'
import {
  buildUserMessage,
  detectAgentAdapter,
  newTaskId,
  type AgentRunAdapter,
  type AgentTaskHandle,
  type HostCtx,
} from '../bridge/agent-bridge.js'
import { mapSessionEvent, type SessionEventLike } from '../bridge/event-map.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

interface ActiveTask {
  taskId: string
  conn: ConnectionHandle
  adapter: AgentRunAdapter
  handle?: AgentTaskHandle
  channel: string
  startedAt: number
  chunks: boolean
  stopRequested: boolean
  settled: boolean
  /** 宿主回推的最后一条 agent/error(用于把最终 status 标成 failed)。 */
  lastError?: string
  offs: (() => void)[]
}

/** registerAgentTask 的可选模型路由配置(缺省时回退宿主默认模型)。 */
export interface AgentTaskOptions {
  provider?: string
  model?: string
}

/**
 * 注册 agent 任务接收器。返回注销函数(同时注销两个接收码)。
 */
export function registerAgentTask(
  ctx: HostCtx,
  hub: Hub,
  logger: LoggerLike,
  options: AgentTaskOptions = {},
): () => void {
  const adapter = detectAgentAdapter(ctx)
  if (adapter) {
    logger.info('host agent service detected: %s', adapter.kind)
  } else {
    logger.warn('no host agent service (agents/agentLoop) — agent.run will reply host.unavailable')
  }

  const tasksByTaskId = new Map<string, ActiveTask>()
  const tasksByConn = new Map<string, Set<string>>()
  const connHooked = new Set<string>() // connId → 已挂断开清理钩子

  function unsubscribeAll(task: ActiveTask): void {
    for (const off of task.offs) {
      try {
        off()
      } catch (error) {
        logger.warn('remove host listener failed: %o', error)
      }
    }
    task.offs = []
  }

  /** 收尾(幂等):标记 settled → 清任务表 → 注销监听 → 退订主题 → dispose agent。 */
  async function teardown(task: ActiveTask): Promise<void> {
    if (task.settled) return
    task.settled = true
    tasksByTaskId.delete(task.taskId)
    tasksByConn.get(task.conn.id)?.delete(task.taskId)
    unsubscribeAll(task)
    hub.unsubscribe(task.conn, task.channel)
    try {
      await task.handle?.dispose()
    } catch (error) {
      logger.warn('dispose agent %s failed: %o', task.taskId, error)
    }
  }

  /** 请求取消(cancel 兜底:无 cancel 能力则直接 teardown)。 */
  function requestCancel(task: ActiveTask): void {
    task.stopRequested = true
    try {
      const agent = task.handle?.agent
      if (agent?.cancel) agent.cancel({ kind: 'user' })
      else void teardown(task)
    } catch (error) {
      logger.warn('cancel agent %s failed: %o', task.taskId, error)
    }
  }

  function ensureConnHook(conn: ConnectionHandle): void {
    if (connHooked.has(conn.id)) return
    connHooked.add(conn.id)
    hub.onConnClose(conn, () => {
      const ids = tasksByConn.get(conn.id)
      if (!ids) return
      for (const taskId of [...ids]) {
        const task = tasksByTaskId.get(taskId)
        if (task) {
          requestCancel(task)
          void teardown(task)
        }
      }
    })
  }

  function registerTask(task: ActiveTask, conn: ConnectionHandle): void {
    tasksByTaskId.set(task.taskId, task)
    let ids = tasksByConn.get(conn.id)
    if (!ids) {
      ids = new Set()
      tasksByConn.set(conn.id, ids)
    }
    ids.add(task.taskId)
    ensureConnHook(conn)
  }

  async function runAgentTask(payload: JsonValue | undefined, recvCtx: RecvCtx): Promise<unknown> {
    const { conn } = recvCtx
    if (!isRecord(payload) || typeof payload.prompt !== 'string' || payload.prompt.length === 0) {
      throw new TaskError(ErrorCodes.BAD_REQUEST, 'agent.run requires payload.prompt (non-empty string)')
    }
    if (!adapter) {
      throw new TaskError(ErrorCodes.HOST_UNAVAILABLE, 'host agent service (agents/agentLoop) is unavailable')
    }
    const prompt = payload.prompt
    const cwd = typeof payload.cwd === 'string' ? payload.cwd : undefined
    const chunks = payload.chunks === true

    const taskId = newTaskId()
    const task: ActiveTask = {
      taskId,
      conn,
      adapter,
      channel: taskTopic(taskId),
      startedAt: Date.now(),
      chunks,
      stopRequested: false,
      settled: false,
      offs: [],
    }

    // 发起连接自动订阅本任务事件主题
    recvCtx.subscribe(task.channel)
    registerTask(task, conn)

    // 宿主全局监听(按 session id 过滤;规避 scope 语义差异,两个适配器共用同一路径)
    const onSessionEvent = (session: unknown, event: unknown): void => {
      if (task.settled) return
      if (!isRecord(session) || session.id !== task.taskId) return
      const payload = mapSessionEvent(event as SessionEventLike)
      if (!payload) return
      if (payload.kind === 'assistant.chunk' && !task.chunks) return
      hub.publish(task.channel, payload as unknown as JsonValue)
    }
    const onAgentStatus = (arg: unknown): void => {
      if (task.settled) return
      const info = isRecord(arg) ? arg : {}
      const agent = isRecord(info.agent) ? info.agent : undefined
      if (agent && agent.id === task.taskId) {
        hub.publish(task.channel, {
          kind: 'agent.status',
          status: typeof info.status === 'string' ? info.status : 'unknown',
        } as unknown as JsonValue)
      }
    }
    const onAgentError = (arg: unknown): void => {
      if (task.settled) return
      const info = isRecord(arg) ? arg : {}
      const agent = isRecord(info.agent) ? info.agent : undefined
      if (agent && agent.id === task.taskId) {
        const message = errorMessage(info.error)
        task.lastError = message
        hub.publish(task.channel, {
          kind: 'agent.error',
          message,
        } as unknown as JsonValue)
      }
    }
    ctx.on('session/event', onSessionEvent)
    ctx.on('agent/status', onAgentStatus)
    ctx.on('agent/error', onAgentError)
    task.offs = [
      () => ctx.off('session/event', onSessionEvent),
      () => ctx.off('agent/status', onAgentStatus),
      () => ctx.off('agent/error', onAgentError),
    ]

    let handle: AgentTaskHandle
    try {
      handle = await task.adapter.create({
        sessionId: task.taskId,
        cwd,
        provider: options.provider,
        model: options.model,
      })
    } catch (error) {
      logger.error('start agent %s failed: %o', task.taskId, error)
      unsubscribeAll(task)
      recvCtx.unsubscribe(task.channel)
      tasksByTaskId.delete(task.taskId)
      tasksByConn.get(conn.id)?.delete(task.taskId)
      throw new TaskError(ErrorCodes.AGENT_FAILED, errorMessage(error))
    }
    task.handle = handle

    // 驱动:先投递消息再等静默(AGENTS.md 实测顺序,whenIdle 在入队后调用)
    try {
      handle.agent.followup(buildUserMessage(prompt))
    } catch (error) {
      logger.error('followup agent %s failed: %o', task.taskId, error)
      void teardown(task)
      throw new TaskError(ErrorCodes.AGENT_FAILED, errorMessage(error))
    }
    try {
      await handle.agent.whenIdle()
    } catch (error) {
      // 连接断开/stop 已 teardown dispose 时,等待会被打断,属预期
      logger.warn('whenIdle agent %s interrupted: %o', task.taskId, error)
    }

    const status = task.stopRequested ? 'stopped' : task.lastError ? 'failed' : 'done'
    await teardown(task)
    return {
      taskId: task.taskId,
      sessionId: task.taskId,
      status,
      durationMs: Date.now() - task.startedAt,
      ...(task.lastError === undefined ? {} : { error: task.lastError }),
    }
  }

  async function stopAgentTask(payload: JsonValue | undefined, recvCtx: RecvCtx): Promise<unknown> {
    const { conn } = recvCtx
    if (!isRecord(payload) || typeof payload.taskId !== 'string' || !payload.taskId) {
      throw new TaskError(ErrorCodes.BAD_REQUEST, 'agent.stop requires payload.taskId (string)')
    }
    const task = tasksByTaskId.get(payload.taskId)
    if (!task) {
      throw new TaskError(ErrorCodes.AGENT_NOT_FOUND, `task "${payload.taskId}" not found`)
    }
    if (task.conn.id !== conn.id) {
      throw new TaskError(ErrorCodes.FORBIDDEN, 'only the originating connection may stop a task')
    }
    requestCancel(task)
    return { taskId: task.taskId, status: 'stopped' }
  }

  const offRun = hub.registerReceiver('agent.run', runAgentTask)
  const offStop = hub.registerReceiver('agent.stop', stopAgentTask)
  return () => {
    offRun()
    offStop()
  }
}

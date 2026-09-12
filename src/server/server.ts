/**
 * LAN WebSocket 代理服务。
 * 由插件 apply 创建,随插件卸载销毁(避免顶层副作用与端口泄漏)。
 *
 * 职责:
 *  1. 把真实 socket 包装成 ConnectionHandle(JSON 序列化 + 关闭静默 + 单连接错误隔离)。
 *  2. 逐帧 codec 分派:req → hub 分派接收器;sub → 订阅管理;ping → pong。
 *  3. boot 时注册内置任务(agent.run / agent.stop,插件内部注册)。
 *  4. 返回 { dispose, hub, port }:hub 供内部模块扩展;port 供测试拿随机端口。
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import type { Config } from '../config/config.js'
import { detectAgentAdapter, type HostCtx } from '../bridge/agent-bridge.js'
import { createHub, type ConnectionHandle, type Hub } from '../hub/hub.js'
import {
  ErrorCodes,
  errFrame,
  parseFrame,
  pongFrame,
  resOk,
  type C2S,
  type S2C,
} from '../protocol/frame.js'
import { registerAgentTask } from '../tasks/agent-task.js'
import { registerSessionTask } from '../tasks/session-task.js'
import { createMemorySessionIndex, type SessionIndex } from '../sessions/session-index.js'
import { createSessionRegistry } from '../sessions/session-registry.js'
import { readPersistedHistory } from '../sessions/persisted-history.js'
import { createHostSessionReader } from '../sessions/host-sessions.js'
import { createHttpServer } from '../http/http-server.js'

/** ws message 的 data 可能有 Buffer / ArrayBuffer / Buffer[] 三种形态,统一成 Buffer。 */
function toBuffer(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data)
  if (Buffer.isBuffer(data)) return data
  return Buffer.from(data)
}

export interface ProxyServer {
  /** 关闭服务并释放端口(幂等)。 */
  dispose(): Promise<void>
  /** 消息枢纽(内部扩展点:注册接收器 / 推送)。 */
  hub: Hub
  /** 监听就绪后的实际端口(配置 listenPort 0 时用于获取随机端口)。 */
  port: Promise<number>
  /** HTTP 只读接口的实际端口(-1 表示已禁用)。 */
  httpPort: Promise<number>
}

export interface ServerDeps {
  /** 会话索引;缺省用内存实现(dbPath 禁用时)。 */
  sessionIndex?: SessionIndex
}

export function createServer(ctx: Context, config: Config, deps: ServerDeps = {}): ProxyServer {
  const logger = ctx.logger('dsh-connect/server')
  const host = ctx as unknown as HostCtx
  const hub = createHub(logger)

  // boot:插件内部注册内置任务接收器
  let registry: ReturnType<typeof createSessionRegistry> | undefined
  const disposers: (() => void)[] = []
  disposers.push(
    registerAgentTask(host, hub, ctx.logger('dsh-connect/task'), {
      provider: config.agentProvider,
      model: config.agentModel,
    }),
  )

  // 会话索引与宿主读取器:WS 与 HTTP 共用,所以放在 adapter 判定之外
  // (HTTP 在无 agent 服务时仍应能列宿主会话并读历史)
  const sessionIndex = deps.sessionIndex ?? createMemorySessionIndex()
  const hostReader = createHostSessionReader(host, ctx.logger('dsh-connect/host'))

  // 会话能力:依赖宿主 agent 服务;没有则只注册一次性任务
  const adapter = detectAgentAdapter(host)
  if (adapter) {
    const sessionLogger = ctx.logger('dsh-connect/session')
    registry = createSessionRegistry(host, hub, adapter, sessionIndex, sessionLogger, {
      idleTimeoutMs: config.sessionIdleTimeoutMs,
      approvalTimeoutMs: config.approvalTimeoutMs,
      provider: config.agentProvider,
      model: config.agentModel,
      // resume 后补齐历史(否则恢复的会话只有 resume 之后的消息)
      loadHistory: (sessionId) => readPersistedHistory(host, sessionId),
      // 用宿主存在性判定 resume/create(对已持久化 id 直接 create 会异步碰撞)
      probeSession: (sessionId) => hostReader.exists(sessionId),
    })
    disposers.push(
      registerSessionTask({
        host,
        hub,
        logger: sessionLogger,
        index: sessionIndex,
        registry,
        hostReader,
      }),
    )
    logger.info('session capability enabled (idle timeout %dms)', config.sessionIdleTimeoutMs)
  } else {
    logger.warn('no host agent service — session.* receivers not registered')
  }

  // HTTP 只读接口(独立端口;失败不影响 WS)
  const httpServer = createHttpServer(ctx, config, {
    host,
    hostReader,
    sessionIndex,
    ...(registry === undefined ? {} : { registry }),
  })

  const wss = new WebSocketServer({
    host: config.hostName,
    port: config.listenPort,
  })
  const conns = new Set<ConnectionHandle>()
  let disposed = false
  let closed = false

  let portResolved = false
  let resolvePort!: (value: number) => void
  const port = new Promise<number>((resolve) => {
    resolvePort = resolve
  })
  const settlePort = (value: number): void => {
    if (portResolved) return
    portResolved = true
    resolvePort(value)
  }

  wss.on('listening', () => {
    const address = wss.address()
    const actual = typeof address === 'object' && address !== null ? address.port : config.listenPort
    logger.info('ws server listening on %s:%d', config.hostName, actual)
    settlePort(actual)
  })

  wss.on('connection', (socket) => {
    if (disposed) {
      socket.close(1001, 'server shutting down')
      return
    }
    const conn: ConnectionHandle = {
      id: randomUUID(),
      // 契约:send 绝不抛异常;连接非 OPEN 时静默丢弃(关闭后的 res/evt 变 no-op)
      send(frame: S2C) {
        if (socket.readyState !== WebSocket.OPEN) return
        try {
          socket.send(JSON.stringify(frame))
        } catch (error) {
          logger.warn('send to client %s failed: %o', conn.id, error)
        }
      },
    }
    conns.add(conn)
    logger.info('client connected: %s', conn.id)

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        conn.send(errFrame(ErrorCodes.BAD_FRAME, 'binary frames are not supported'))
        return
      }
      const parsed = parseFrame(toBuffer(data))
      if (!parsed.ok) {
        conn.send(errFrame(parsed.code, parsed.message))
        return
      }
      const frame: C2S = parsed.frame
      switch (frame.kind) {
        case 'req':
          hub.dispatch(conn, frame)
          break
        case 'sub': {
          for (const code of frame.add ?? []) hub.subscribe(conn, code)
          for (const code of frame.remove ?? []) hub.unsubscribe(conn, code)
          if (frame.id) conn.send(resOk(frame.id))
          break
        }
        case 'ping':
          conn.send(pongFrame())
          break
      }
    })

    socket.on('close', () => {
      conns.delete(conn)
      hub.clearConn(conn)
      logger.info('client disconnected: %s', conn.id)
    })
    socket.on('error', (error) => {
      logger.warn('client %s error: %o', conn.id, error)
    })
  })

  wss.on('error', (error) => {
    logger.error('ws server error: %o', error)
    // 端口绑定失败(如 EADDRINUSE):port 回退到配置值,避免等待方悬挂
    settlePort(config.listenPort)
  })

  return {
    hub,
    port,
    httpPort: httpServer.port,
    dispose: async () => {
      if (disposed) return
      disposed = true
      for (const disposer of disposers) {
        try {
          disposer()
        } catch (error) {
          logger.warn('dispose receiver failed: %o', error)
        }
      }
      // 先停 HTTP(不再接新请求),再释放会话
      try {
        await httpServer.dispose()
      } catch (error) {
        logger.warn('dispose http server failed: %o', error)
      }
      // 会话常驻 agent 与宿主监听统一释放
      if (registry) {
        try {
          await registry.disposeAll()
        } catch (error) {
          logger.warn('dispose sessions failed: %o', error)
        }
      }
      for (const conn of [...conns]) hub.clearConn(conn)
      conns.clear()
      for (const client of wss.clients) {
        try {
          client.close()
        } catch (error) {
          logger.warn('close client failed: %o', error)
        }
      }
      // 从未成功监听时无需(也无法)优雅关闭
      if (!closed && wss.address()) {
        closed = true
        await new Promise<void>((resolve) => {
          wss.close(() => resolve())
        })
      }
      logger.info('ws server disposed')
    },
  }
}

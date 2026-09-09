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
import type { HostCtx } from '../bridge/agent-bridge.js'
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
}

export function createServer(ctx: Context, config: Config): ProxyServer {
  const logger = ctx.logger('dsh-connect/server')
  const host = ctx as unknown as HostCtx
  const hub = createHub(logger)

  // boot:插件内部注册内置任务接收器
  const disposers: (() => void)[] = []
  disposers.push(registerAgentTask(host, hub, ctx.logger('dsh-connect/task')))

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

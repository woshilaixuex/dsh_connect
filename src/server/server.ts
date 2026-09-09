import type { Context } from '@deepseek-ai/cordis'
import { WebSocketServer } from 'ws'
import type { Config } from '../config/config.js'

/**
 * LAN WebSocket 代理服务。
 * 由插件 apply 创建,随插件卸载销毁(避免顶层副作用与端口泄漏)。
 */
export interface ProxyServer {
  /** 关闭并释放端口 */
  dispose(): Promise<void>
}

export function createServer(ctx: Context, config: Config): ProxyServer {
  const logger = ctx.logger('dsh-connect/server')

  const wss = new WebSocketServer({
    host: config.hostName,
    port: config.listenPort,
  })

  wss.on('listening', () => {
    logger.info('ws server listening on %s:%d', config.hostName, config.listenPort)
  })

  wss.on('connection', (socket) => {
    logger.info('client connected')
    socket.on('message', (data) => {
      logger.info('client message: %s', String(data))
      // TODO: 接收任务 → 转接给 dsh(agentLoop)→ 回传执行事件
    })
    socket.on('close', () => logger.info('client disconnected'))
    socket.on('error', (error) => logger.warn('client error: %o', error))
  })

  wss.on('error', (error) => {
    logger.error('ws server error: %o', error)
  })

  return {
    dispose: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate()
        wss.close(() => resolve())
      }),
  }
}

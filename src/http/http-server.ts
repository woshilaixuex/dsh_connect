/**
 * HTTP 只读接口服务(node:http,零依赖)。
 *
 * 与 WS 分离端口,职责单一:
 *  - 只处理 GET/HEAD(读);OPTIONS 回预检;CORS 全开(局域网信任模型)
 *  - 生命周期绑定插件:dispose 时关服务(幂等)
 *  - **失败隔离**:端口绑定失败只记 error,绝不影响 WS
 *
 * 路由逻辑在 routes.ts(纯函数),这里只做 socket 层:解析请求、写响应、记日志。
 */

import { createServer as createHttp } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_CONFIG, type Config } from '../config/config.js'
import type { HostCtx } from '../bridge/agent-bridge.js'
import type { LoggerLike } from '../hub/hub.js'
import type { SessionIndex } from '../sessions/session-index.js'
import type { SessionRegistry } from '../sessions/session-registry.js'
import type { HostSessionReader } from '../sessions/host-sessions.js'
import { createHandler, type RouteDeps } from './routes.js'

/** 响应体上限(防止超大 JSON 撑爆内存/网络)。 */
const MAX_BODY_BYTES = 4 * 1024 * 1024

export interface HttpServerDeps {
  host: HostCtx
  hostReader: HostSessionReader
  sessionIndex: SessionIndex
  registry?: SessionRegistry
}

export interface HttpServerHandle {
  /** 关闭服务(幂等)。 */
  dispose(): Promise<void>
  /** 监听就绪后的实际端口(配置 0 时用于随机端口)。 */
  port: Promise<number>
}

export function createHttpServer(ctx: Context, config: Config, deps: HttpServerDeps): HttpServerHandle {
  const logger = ctx.logger('dsh-connect/http')
  // 防御:调用方传了不完整的 config(如单测只给 WS 字段)时回退默认端口
  const desiredPort = typeof config.httpPort === 'number' ? config.httpPort : DEFAULT_CONFIG.httpPort

  const routeDeps: RouteDeps = {
    host: deps.host,
    hostReader: deps.hostReader,
    sessionIndex: deps.sessionIndex,
    ...(deps.registry === undefined ? {} : { registry: deps.registry }),
    logger,
    startedAt: Date.now(),
  }
  const handler = createHandler(routeDeps)

  /** CORS + 缓存策略:所有响应都带。 */
  function applyCommonHeaders(res: ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
    res.setHeader('Access-Control-Max-Age', '86400')
    res.setHeader('Cache-Control', 'no-store')
  }

  function sendJson(res: ServerResponse, status: number, body: unknown, headOnly: boolean): void {
    let text: string
    try {
      text = JSON.stringify(body)
    } catch (error) {
      logger.error('HTTP response serialization failed: %o', error)
      text = JSON.stringify({ ok: false, code: 'internal', message: 'response serialization failed' })
      status = 500
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
      logger.warn('HTTP response exceeds %d bytes, truncating to an error body', MAX_BODY_BYTES)
      text = JSON.stringify({ ok: false, code: 'response.too.large', message: 'response exceeds size limit' })
      status = 500
    }
    applyCommonHeaders(res)
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Length', String(Buffer.byteLength(text, 'utf8')))
    if (headOnly) res.end()
    else res.end(text)
  }

  const server = createHttp((req: IncomingMessage, res: ServerResponse) => {
    const startedAt = Date.now()
    const method = req.method ?? 'GET'
    // 用固定 base 解析相对 URL;只取 pathname 与 searchParams
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname

    // CORS 预检:直接 204,不进路由
    if (method === 'OPTIONS') {
      logger.debug?.('HTTP preflight: %s %s', method, path)
      applyCommonHeaders(res)
      res.statusCode = 204
      res.end()
      return
    }

    const request = { method, path, query: url.searchParams }
    handler(request)
      .then((result) => {
        const headOnly = method === 'HEAD'
        sendJson(res, result.status, result.body, headOnly)
        // 每请求一行,便于排查「客户端说取不到数据」
        const summary = summarize(result)
        logger.info('HTTP %s %s -> %d (%dms)%s', method, path, result.status, Date.now() - startedAt, summary)
      })
      .catch((error: unknown) => {
        logger.error('HTTP request failed: %o', error)
        sendJson(res, 500, { ok: false, code: 'internal', message: 'internal error', status: 500 }, false)
      })
  })

  let disposed = false
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

  server.on('listening', () => {
    const address = server.address()
    const actual = typeof address === 'object' && address !== null ? address.port : desiredPort
    logger.info('http server listening on %s:%d (read-only GET API)', config.hostName, actual)
    settlePort(actual)
  })

  server.on('error', (error) => {
    // HTTP 起不来不能拖垮 WS:只记 error 并让 port 落地,避免等待方悬挂
    logger.error('http server error (WS is unaffected): %o', error)
    settlePort(desiredPort)
  })

  // 端口 -1 = 显式禁用
  if (desiredPort === -1) {
    logger.info('http api disabled (httpPort = -1)')
    settlePort(-1)
  } else {
    server.listen(desiredPort, config.hostName)
  }

  return {
    port,
    dispose: async () => {
      if (disposed) return
      disposed = true
      if (desiredPort === -1) {
        logger.info('http server disposed (was disabled)')
        return
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // close() 不回收 keep-alive 连接;显式关闭避免 dispose 悬挂
        server.closeAllConnections?.()
      })
      logger.info('http server disposed')
    },
  }
}

/** 给日志用的一句话摘要(条数/来源),避免把整个 body 打进日志。 */
function summarize(result: { body: unknown }): string {
  if (typeof result.body !== 'object' || result.body === null) return ''
  const body = result.body as Record<string, unknown>
  if (Array.isArray(body.sessions)) return `, ${body.sessions.length} sessions`
  if (Array.isArray(body.workspaces)) return `, ${body.workspaces.length} workspaces (source=${String(body.source)})`
  if (Array.isArray(body.messages)) return `, ${body.messages.length} messages (source=${String(body.source)})`
  if (body.ok === false) return `, error=${String(body.code)}`
  return ''
}

/** 便于测试注入的日志类型别名(与 cordis Logger 结构兼容)。 */
export type HttpLogger = LoggerLike

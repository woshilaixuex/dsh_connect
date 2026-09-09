/**
 * dsh-connect 消息枢纽:连接句柄、接收器注册表、推送主题注册表。
 *
 * 纯逻辑实现,不依赖 ws(server.ts 负责把真实 socket 包装成 ConnectionHandle)。
 * 语义:
 *  - 接收:registerReceiver(code, handler) 注册;dispatch(conn, req) 按接收码匹配处理器,
 *    处理器返回值 → res ok;抛 TaskError → 对应稳定错误码;其它异常 → internal。
 *  - 推送:subscribe/unsubscribe 维护「连接 × 推送码」订阅;publish(code, data)
 *    只发给已订阅该码的连接(未订阅不推送)。
 *  - 生命周期:clearConn(conn) 在连接断开时清空订阅并触发 onClose 回调(供任务清理用)。
 */

import {
  ErrorCodes,
  evtFrame,
  resErr,
  resOk,
  type EvtFrame,
  type JsonValue,
  type ReqFrame,
  type S2C,
} from '../protocol/frame.js'

/** hub 内部诊断日志的最小接口(与 cordis Logger 结构兼容)。 */
export interface LoggerLike {
  info(message?: unknown, ...args: unknown[]): void
  warn(message?: unknown, ...args: unknown[]): void
  error(message?: unknown, ...args: unknown[]): void
  debug?(message?: unknown, ...args: unknown[]): void
}

/** 一条客户端连接的抽象:实现方保证 send 绝不抛异常、连接关闭后静默丢弃。 */
export interface ConnectionHandle {
  readonly id: string
  send(frame: S2C): void
}

/**
 * 处理器可抛的业务错误:code 用稳定错误码(ErrorCodes 或自定义),会原样回给客户端。
 * 非 TaskError 的异常统一按 internal 处理。
 */
export class TaskError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'TaskError'
  }
}

/** 处理器上下文:handler 可用它把发起连接动态加入/移出某个推送主题(任务事件流用)。 */
export interface RecvCtx {
  conn: ConnectionHandle
  subscribe(pushCode: string): void
  unsubscribe(pushCode: string): void
}

export type ReceiverHandler = (
  payload: JsonValue | undefined,
  ctx: RecvCtx,
) => Promise<unknown> | unknown

export interface Hub {
  /** 注册接收处理器(接收码 → handler);返回注销函数。 */
  registerReceiver(code: string, handler: ReceiverHandler): () => void
  /** 分派一个 req 帧(已通过 codec 校验)。异步执行,不阻塞调用方。 */
  dispatch(conn: ConnectionHandle, frame: ReqFrame): void
  /** 订阅推送码;重复订阅幂等。未知码静默接受(动态主题,如 task:<id>)。 */
  subscribe(conn: ConnectionHandle, pushCode: string): void
  /** 退订推送码;未订阅则静默。 */
  unsubscribe(conn: ConnectionHandle, pushCode: string): void
  /** 推送到某个推送码;只发给已订阅且仍活跃的连接。 */
  publish(pushCode: string, data?: JsonValue): void
  /** 注册连接断开回调;返回注销函数。 */
  onConnClose(conn: ConnectionHandle, fn: () => void): () => void
  /** 连接断开时调用:清空其全部订阅,再触发 onClose 回调。幂等。 */
  clearConn(conn: ConnectionHandle): void
}

export function createHub(logger: LoggerLike): Hub {
  const receivers = new Map<string, ReceiverHandler>()
  // 连接 id → 该连接订阅的推送码集合
  const connSubs = new Map<string, Set<string>>()
  // 推送码 → 订阅者(连接 id → handle)
  const subsByCode = new Map<string, Map<string, ConnectionHandle>>()
  // 连接 id → 断开回调集合
  const closeHooks = new Map<string, Set<() => void>>()

  function subscribe(conn: ConnectionHandle, pushCode: string): void {
    if (!pushCode) return
    let codes = connSubs.get(conn.id)
    if (!codes) {
      codes = new Set()
      connSubs.set(conn.id, codes)
    }
    if (codes.has(pushCode)) return
    codes.add(pushCode)

    let conns = subsByCode.get(pushCode)
    if (!conns) {
      conns = new Map()
      subsByCode.set(pushCode, conns)
    }
    conns.set(conn.id, conn)
  }

  function unsubscribe(conn: ConnectionHandle, pushCode: string): void {
    const codes = connSubs.get(conn.id)
    if (!codes?.delete(pushCode)) return
    const conns = subsByCode.get(pushCode)
    conns?.delete(conn.id)
    if (conns && conns.size === 0) subsByCode.delete(pushCode)
  }

  function clearConn(conn: ConnectionHandle): void {
    // 先清订阅(断开后 publish 不再命中),再触发回调
    const codes = connSubs.get(conn.id)
    if (codes) {
      for (const pushCode of codes) {
        const conns = subsByCode.get(pushCode)
        conns?.delete(conn.id)
        if (conns && conns.size === 0) subsByCode.delete(pushCode)
      }
      connSubs.delete(conn.id)
    }
    const hooks = closeHooks.get(conn.id)
    if (hooks) {
      closeHooks.delete(conn.id)
      for (const fn of hooks) {
        try {
          fn()
        } catch (error) {
          logger.warn('conn close hook failed: %o', error)
        }
      }
    }
  }

  /** hub 内统一发送口:单连接异常不扩散。 */
  function sendSafe(conn: ConnectionHandle, frame: S2C): void {
    try {
      conn.send(frame)
    } catch (error) {
      logger.warn('send to conn %s failed: %o', conn.id, error)
    }
  }

  return {
    registerReceiver(code, handler) {
      if (receivers.has(code)) {
        throw new TaskError(ErrorCodes.INTERNAL, `receiver "${code}" already registered`)
      }
      receivers.set(code, handler)
      return () => {
        if (receivers.get(code) === handler) receivers.delete(code)
      }
    },

    dispatch(conn, frame) {
      const handler = receivers.get(frame.code)
      if (!handler) {
        sendSafe(conn, resErr(frame.id, ErrorCodes.UNKNOWN_CODE, `no receiver for code "${frame.code}"`))
        return
      }
      const recvCtx: RecvCtx = {
        conn,
        subscribe: (code) => subscribe(conn, code),
        unsubscribe: (code) => unsubscribe(conn, code),
      }
      Promise.resolve()
        .then(() => handler(frame.payload, recvCtx))
        .then(
          (data) => {
            sendSafe(
              conn,
              data === undefined ? resOk(frame.id) : resOk(frame.id, data as JsonValue),
            )
          },
          (error: unknown) => {
            if (error instanceof TaskError) {
              sendSafe(conn, resErr(frame.id, error.code, error.message))
              return
            }
            logger.error('receiver "%s" failed: %o', frame.code, error)
            const message = error instanceof Error ? error.message : String(error)
            sendSafe(conn, resErr(frame.id, ErrorCodes.INTERNAL, message))
          },
        )
    },

    subscribe,
    unsubscribe,

    publish(pushCode, data) {
      const conns = subsByCode.get(pushCode)
      if (!conns || conns.size === 0) return
      const frame: EvtFrame = evtFrame(pushCode, data)
      for (const conn of conns.values()) {
        sendSafe(conn, frame)
      }
    },

    onConnClose(conn, fn) {
      let hooks = closeHooks.get(conn.id)
      if (!hooks) {
        hooks = new Set()
        closeHooks.set(conn.id, hooks)
      }
      hooks.add(fn)
      return () => hooks?.delete(fn)
    },

    clearConn,
  }
}

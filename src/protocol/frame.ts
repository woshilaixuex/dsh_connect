/**
 * dsh-connect 线协议:帧类型、错误码、编解码(纯函数,不依赖 ws)。
 *
 * 帧一律 JSON 文本,单帧上限 MAX_FRAME_BYTES。语义分两个方向:
 *  - req(接收):客户端按「接收码」提交请求,服务端回 res(ok/data 或 code/message)。
 *  - evt(推送):服务端按「推送码」把事件推给所有已订阅该码的连接。
 * 连接订阅用 sub 帧管理(本连接级),断开自动清空。
 */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export const PROTOCOL_VERSION = 1

/** 单帧最大字节数(超出直接回 bad.size)。 */
export const MAX_FRAME_BYTES = 256 * 1024

/** 帧内 id / code / 推送码的最大字符数。 */
const MAX_CODE_LEN = 128

/** 稳定错误码。帧级:bad.frame / bad.size;请求级:其余。 */
export const ErrorCodes = {
  BAD_FRAME: 'bad.frame',
  BAD_SIZE: 'bad.size',
  UNKNOWN_CODE: 'unknown.code',
  INTERNAL: 'internal',
  HOST_UNAVAILABLE: 'host.unavailable',
  AGENT_FAILED: 'agent.failed',
  AGENT_NOT_FOUND: 'agent.not.found',
  BAD_REQUEST: 'bad.request',
  FORBIDDEN: 'forbidden',
  SESSION_NOT_FOUND: 'session.not.found',
  SESSION_BUSY: 'session.busy',
  SESSION_RESUME_FAILED: 'session.resume-failed',
  APPROVAL_NOT_FOUND: 'approval.not.found',
} as const
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

/** 推送码约定前缀。 */
export const PushPrefix = {
  /** 一次性任务事件流:task:<taskId> */
  TASK: 'task:',
  /** 会话事件流:session:<sessionId> */
  SESSION: 'session:',
} as const

/** 组装会话推送码。 */
export function sessionTopic(sessionId: string): string {
  return `${PushPrefix.SESSION}${sessionId}`
}

/** 组装任务推送码。 */
export function taskTopic(taskId: string): string {
  return `${PushPrefix.TASK}${taskId}`
}

// ---------- 客户端 → 服务端 ----------

export interface ReqFrame {
  v: typeof PROTOCOL_VERSION
  kind: 'req'
  /** 请求 id,客户端自选,用于关联 res */
  id: string
  /** 接收码 */
  code: string
  payload?: JsonValue
}

export interface SubFrame {
  v: typeof PROTOCOL_VERSION
  kind: 'sub'
  /** 可选;带上则服务端回一个 res ok 确认 */
  id?: string
  /** 要订阅的推送码 */
  add?: string[]
  /** 要退订的推送码 */
  remove?: string[]
}

export interface PingFrame {
  v: typeof PROTOCOL_VERSION
  kind: 'ping'
}

export type C2S = ReqFrame | SubFrame | PingFrame

// ---------- 服务端 → 客户端 ----------

export interface ResOkFrame {
  v: typeof PROTOCOL_VERSION
  kind: 'res'
  id: string
  ok: true
  data?: JsonValue
}

export interface ResErrFrame {
  v: typeof PROTOCOL_VERSION
  kind: 'res'
  id: string
  ok: false
  code: string
  message: string
}

export interface EvtFrame {
  v: typeof PROTOCOL_VERSION
  kind: 'evt'
  /** 推送码 */
  push: string
  data?: JsonValue
  ts: number
}

/** 帧级错误(无请求 id 可关联时使用,例如解析失败)。 */
export interface ErrFrame {
  v: typeof PROTOCOL_VERSION
  kind: 'err'
  code: string
  message: string
}

export interface PongFrame {
  v: typeof PROTOCOL_VERSION
  kind: 'pong'
}

export type S2C = ResOkFrame | ResErrFrame | EvtFrame | ErrFrame | PongFrame

// ---------- 构造器 ----------

export function resOk(id: string, data?: JsonValue): ResOkFrame {
  return data === undefined
    ? { v: PROTOCOL_VERSION, kind: 'res', id, ok: true }
    : { v: PROTOCOL_VERSION, kind: 'res', id, ok: true, data }
}

export function resErr(id: string, code: string, message: string): ResErrFrame {
  return { v: PROTOCOL_VERSION, kind: 'res', id, ok: false, code, message }
}

export function evtFrame(push: string, data?: JsonValue, ts = Date.now()): EvtFrame {
  return data === undefined
    ? { v: PROTOCOL_VERSION, kind: 'evt', push, ts }
    : { v: PROTOCOL_VERSION, kind: 'evt', push, data, ts }
}

export function errFrame(code: string, message: string): ErrFrame {
  return { v: PROTOCOL_VERSION, kind: 'err', code, message }
}

export function pongFrame(): PongFrame {
  return { v: PROTOCOL_VERSION, kind: 'pong' }
}

// ---------- 解析 ----------

export type ParseResult =
  | { ok: true; frame: C2S }
  | { ok: false; code: ErrorCode; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验字符串字段;缺失/非字符串/超长返回 undefined。 */
function strField(o: Record<string, unknown>, key: string, maxLen = MAX_CODE_LEN): string | undefined {
  const value = o[key]
  if (typeof value !== 'string') return undefined
  if (value.length === 0 || value.length > maxLen) return undefined
  return value
}

/** 校验字符串数组字段;非数组/含非法元素返回 undefined。 */
function strListField(o: Record<string, unknown>, key: string): string[] | undefined {
  const value = o[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item.length > MAX_CODE_LEN) return undefined
    out.push(item)
  }
  return out
}

/**
 * 解析一帧文本消息。
 * 任何不合法输入都返回 { ok:false }(帧级错误),绝不抛异常。
 */
export function parseFrame(input: Buffer | string): ParseResult {
  const raw = typeof input === 'string' ? input : input.toString('utf8')
  if (Buffer.byteLength(raw, 'utf8') > MAX_FRAME_BYTES) {
    return { ok: false, code: ErrorCodes.BAD_SIZE, message: `frame exceeds ${MAX_FRAME_BYTES} bytes` }
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { ok: false, code: ErrorCodes.BAD_FRAME, message: 'invalid JSON' }
  }
  if (!isRecord(json)) {
    return { ok: false, code: ErrorCodes.BAD_FRAME, message: 'frame must be a JSON object' }
  }
  if (json.v !== PROTOCOL_VERSION) {
    return { ok: false, code: ErrorCodes.BAD_FRAME, message: `unsupported protocol version` }
  }

  switch (json.kind) {
    case 'req': {
      const id = strField(json, 'id')
      const code = strField(json, 'code')
      if (!id || !code) {
        return { ok: false, code: ErrorCodes.BAD_FRAME, message: 'req requires non-empty id and code' }
      }
      const frame: ReqFrame = { v: PROTOCOL_VERSION, kind: 'req', id, code }
      if ('payload' in json) frame.payload = json.payload as JsonValue
      return { ok: true, frame }
    }
    case 'sub': {
      // 字段显式给出但非法 → 报错;缺省(undefined)视为未提供
      if (json.add !== undefined && strListField(json, 'add') === undefined) {
        return { ok: false, code: ErrorCodes.BAD_FRAME, message: 'sub.add must be a string array' }
      }
      if (json.remove !== undefined && strListField(json, 'remove') === undefined) {
        return { ok: false, code: ErrorCodes.BAD_FRAME, message: 'sub.remove must be a string array' }
      }
      const id = strField(json, 'id')
      const add = strListField(json, 'add')
      const remove = strListField(json, 'remove')
      const frame: SubFrame = { v: PROTOCOL_VERSION, kind: 'sub' }
      if (id) frame.id = id
      if (add && add.length > 0) frame.add = add
      if (remove && remove.length > 0) frame.remove = remove
      return { ok: true, frame }
    }
    case 'ping':
      return { ok: true, frame: { v: PROTOCOL_VERSION, kind: 'ping' } }
    default:
      return { ok: false, code: ErrorCodes.BAD_FRAME, message: `unknown frame kind "${String(json.kind)}"` }
  }
}

/**
 * 宿主会话事件 → 线协议推送载荷的映射(纯函数)。
 *
 * 一个宿主事件可能产出**多条**线协议事件(例如 `assistant/message` 同时带思考与正文,
 * 需按顺序分别推送),因此返回数组;空数组表示该事件不推给客户端。
 *
 * 只提取客户端关心的语义事件,无法识别或仅日志类的事件返回空数组,
 * 保证宿主事件演进不破坏协议(前向兼容)。
 */

/** 结构化的宿主 SessionEvent(最小依赖面)。 */
export interface SessionEventLike {
  type: string
  seq?: number
  data?: {
    turn?: number
    step?: number
    message?: unknown
    chunk?: unknown
    callId?: string
    name?: string
    arguments?: string
    error?: { name?: string; code?: string; message?: string }
    todos?: unknown
    active?: unknown
    reason?: { kind?: string }
    [key: string]: unknown
  }
}

/** 一条线协议推送载荷。 */
export type WirePayload = Record<string, unknown>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从 content block 数组里拼出纯文本(text 块)。 */
export function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (isRecord(content)) {
    if (typeof content.text === 'string') return content.text
    if ('content' in content) return textOf(content.content)
  }
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.length > 0 ? parts.join('') : undefined
}

/** 从 content block 数组里拼出思考文本(reasoning 块)。 */
export function reasoningOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'reasoning' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.length > 0 ? parts.join('') : undefined
}

/** 从 content block 数组里收集 tool-call 块。 */
function toolCallsOf(content: unknown): { id: string; name: string; arguments: string }[] | undefined {
  if (!Array.isArray(content)) return undefined
  const calls: { id: string; name: string; arguments: string }[] = []
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === 'tool-call' &&
      typeof block.name === 'string' &&
      typeof block.arguments === 'string'
    ) {
      calls.push({
        id: typeof block.id === 'string' ? block.id : '',
        name: block.name,
        arguments: block.arguments,
      })
    }
  }
  return calls.length > 0 ? calls : undefined
}

/** tool-result 块里的错误信息(工具执行失败)。 */
function errorTextOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (
      isRecord(block) &&
      block.type === 'tool-result' &&
      typeof block.isError === 'boolean' &&
      block.isError
    ) {
      parts.push(textOf(block.content) ?? 'tool failed')
    }
  }
  return parts.length > 0 ? parts.join('; ') : undefined
}

/** 从工具结果中保留客户端可读的文件/引用元数据,不把整块结构化对象暴露给 UI。 */
function toolDetailsOf(block: unknown, data: SessionEventLike['data']): Record<string, unknown> | undefined {
  const sources = [isRecord(block) ? block : undefined, data]
  const details: Record<string, unknown> = {}
  const firstString = (...keys: string[]) => {
    for (const source of sources) {
      for (const key of keys) {
        const value = source?.[key]
        if (typeof value === 'string' && value.length > 0) return value
      }
    }
    return undefined
  }
  const fileName = firstString('fileName', 'filename', 'name')
  const path = firstString('path', 'filePath')
  const url = firstString('url', 'reference', 'ref', 'address')
  if (fileName) details.fileName = fileName
  if (path) details.path = path
  if (url) details.url = url
  for (const source of sources) {
    const attachments = source?.attachments
    if (Array.isArray(attachments)) {
      const readable = attachments.filter(isRecord).map((item) => ({
        ...(typeof item.fileName === 'string' ? { fileName: item.fileName } : {}),
        ...(typeof item.name === 'string' ? { name: item.name } : {}),
        ...(typeof item.path === 'string' ? { path: item.path } : {}),
        ...(typeof item.url === 'string' ? { url: item.url } : {}),
      }))
      if (readable.length > 0) details.attachments = readable
    }
  }
  return Object.keys(details).length > 0 ? details : undefined
}

/** 把宿主 todo 列表规整成线协议形状(丢弃形状不符的项)。 */
function todosOf(raw: unknown): { content: string; status: string }[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const todos: { content: string; status: string }[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.content !== 'string') continue
    const status = typeof item.status === 'string' ? item.status : 'pending'
    todos.push({ content: item.content, status })
  }
  return todos
}

/**
 * 把一条 SessionEvent 映射成 0..n 条推送载荷。
 *
 * 顺序即客户端应呈现的顺序:思考(reasoning)先于正文(assistant.message)。
 */
export function mapSessionEvent(event: SessionEventLike): WirePayload[] {
  const { data } = event

  switch (event.type) {
    case 'assistant/message': {
      const message = isRecord(data) ? data.message : undefined
      const content = isRecord(message) ? message.content : undefined
      const { turn, step } = data ?? {}
      const turnStep = {
        ...(typeof turn === 'number' ? { turn } : {}),
        ...(typeof step === 'number' ? { step } : {}),
      }

      const out: WirePayload[] = []
      // 思考先于正文:客户端可先渲染思考区,再渲染回复
      const reasoning = reasoningOf(content)
      if (reasoning) out.push({ kind: 'assistant.reasoning', text: reasoning, ...turnStep })

      const payload: WirePayload = { kind: 'assistant.message' }
      const text = textOf(content)
      if (text) payload.text = text
      const calls = toolCallsOf(content)
      if (calls) payload.toolCalls = calls
      Object.assign(payload, turnStep)
      out.push(payload)
      return out
    }

    case 'assistant/chunk': {
      const { turn, step } = data ?? {}
      const chunk = data?.chunk
      const turnStep = {
        ...(typeof turn === 'number' ? { turn } : {}),
        ...(typeof step === 'number' ? { step } : {}),
      }
      // 思考增量用独立 kind,便于客户端单独做流式思考区
      if (isRecord(chunk) && chunk.type === 'reasoning-delta') {
        return [
          {
            kind: 'assistant.reasoning-chunk',
            ...(typeof chunk.index === 'number' ? { index: chunk.index } : {}),
            ...(typeof chunk.text === 'string' ? { text: chunk.text } : {}),
            ...turnStep,
          },
        ]
      }
      return [{ kind: 'assistant.chunk', chunk: chunk ?? data, ...turnStep }]
    }

    case 'tool/call': {
      const { callId, name, arguments: args, turn, step } = data ?? {}
      const payload: WirePayload = {
        kind: 'tool.call',
        callId: typeof callId === 'string' ? callId : '',
        name: typeof name === 'string' ? name : '',
        arguments: typeof args === 'string' ? args : '',
      }
      if (typeof turn === 'number') payload.turn = turn
      if (typeof step === 'number') payload.step = step
      return [payload]
    }

    case 'tool/result': {
      const { message, error, turn, step } = data ?? {}
      const block =
        isRecord(message) && Array.isArray(message.content)
          ? (message.content as unknown[]).find((item) => isRecord(item) && item.type === 'tool-result')
          : undefined
      const content = isRecord(block) ? block.content : undefined
      const isError = (isRecord(block) && block.isError === true) || isRecord(error)
      const payload: WirePayload = {
        kind: 'tool.result',
        callId:
          isRecord(block) && typeof block.toolCallId === 'string' ? block.toolCallId : '',
        ok: !isError,
      }
      const text = textOf(content) ?? errorTextOf(content)
      if (text) payload.text = text
      if (isRecord(error)) {
        payload.error = { name: error.name, code: error.code, message: error.message }
      }
      const details = toolDetailsOf(block, data)
      if (details) payload.details = details
      if (typeof turn === 'number') payload.turn = turn
      if (typeof step === 'number') payload.step = step
      return [payload]
    }

    // ── 「当前在做什么」结构 ──────────────────────────────────────────────────

    case 'todo/write': {
      const todos = todosOf(data?.todos)
      return todos === undefined ? [] : [{ kind: 'session.todo', todos }]
    }

    case 'plan/mode': {
      // pending 需投影,由 registry 侧富化;事件本身只有 active
      if (typeof data?.active !== 'boolean') return []
      return [{ kind: 'session.plan', active: data.active }]
    }

    case 'turn/start':
      return typeof data?.turn === 'number' ? [{ kind: 'session.turn', turn: data.turn, phase: 'start' }] : []

    case 'turn/end': {
      if (typeof data?.turn !== 'number') return []
      const reason = isRecord(data.reason) && typeof data.reason.kind === 'string' ? data.reason.kind : undefined
      return [{ kind: 'session.turn', turn: data.turn, phase: 'end', ...(reason ? { reason } : {}) }]
    }

    default:
      // user/message、step/*、request/*、approval/*、session/end-seed 等不推给客户端
      return []
  }
}

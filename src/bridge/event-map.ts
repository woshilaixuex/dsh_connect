/**
 * 宿主会话事件 → 线协议推送载荷的映射(纯函数)。
 *
 * 输入是 session/event 的 SessionEvent 对象(结构类型,见 SessionEventLike);
 * 只提取客户端关心的语义事件,assistant/tool 载荷做了扁平化映射。
 * 无法识别或仅日志类的事件返回 null(静默忽略),保证宿主事件演进不破坏协议。
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
    [key: string]: unknown
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从 content block 数组里拼出纯文本(text 块)。 */
function textOf(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
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

/**
 * 把一条 SessionEvent 映射成推送载荷。
 * @returns 载荷对象(含 kind),无法识别的事件返回 null。
 */
export function mapSessionEvent(event: SessionEventLike): Record<string, unknown> | null {
  const { data } = event
  switch (event.type) {
    case 'assistant/message': {
      const message = isRecord(data) ? data.message : undefined
      const content = isRecord(message) ? message.content : undefined
      const payload: Record<string, unknown> = { kind: 'assistant.message' }
      const text = textOf(content)
      if (text) payload.text = text
      const calls = toolCallsOf(content)
      if (calls) payload.toolCalls = calls
      // reasoning 块文本(content.type === 'reasoning')
      if (Array.isArray(content)) {
        const reasoning: string[] = []
        for (const block of content) {
          if (isRecord(block) && block.type === 'reasoning' && typeof block.text === 'string') {
            reasoning.push(block.text)
          }
        }
        if (reasoning.length > 0) payload.reasoningText = reasoning.join('')
      }
      const { turn, step } = data ?? {}
      if (typeof turn === 'number') payload.turn = turn
      if (typeof step === 'number') payload.step = step
      return payload
    }
    case 'assistant/chunk': {
      const { turn, step } = data ?? {}
      const payload: Record<string, unknown> = { kind: 'assistant.chunk', chunk: data?.chunk ?? data }
      if (typeof turn === 'number') payload.turn = turn
      if (typeof step === 'number') payload.step = step
      return payload
    }
    case 'tool/call': {
      const { callId, name, arguments: args, turn, step } = data ?? {}
      const payload: Record<string, unknown> = {
        kind: 'tool.call',
        callId: typeof callId === 'string' ? callId : '',
        name: typeof name === 'string' ? name : '',
        arguments: typeof args === 'string' ? args : '',
      }
      if (typeof turn === 'number') payload.turn = turn
      if (typeof step === 'number') payload.step = step
      return payload
    }
    case 'tool/result': {
      const { message, error, turn, step } = data ?? {}
      const block = isRecord(message) && Array.isArray(message.content)
        ? (message.content as unknown[]).find(
            (item) => isRecord(item) && item.type === 'tool-result',
          )
        : undefined
      const content = isRecord(block) ? block.content : undefined
      const isError = (isRecord(block) && block.isError === true) || isRecord(error)
      const payload: Record<string, unknown> = {
        kind: 'tool.result',
        callId: typeof (isRecord(block) ? block.toolCallId : undefined) === 'string'
          ? (block as { toolCallId: string }).toolCallId
          : '',
        ok: !isError,
      }
      const text = textOf(content) ?? errorTextOf(content)
      if (text) payload.text = text
      if (isRecord(error)) {
        payload.error = {
          name: error.name,
          code: error.code,
          message: error.message,
        }
      }
      if (typeof turn === 'number') payload.turn = turn
      if (typeof step === 'number') payload.step = step
      return payload
    }
    default:
      // user/message、turn/step/*、request/*、approval/*、session/end-seed 等不推给客户端
      return null
  }
}

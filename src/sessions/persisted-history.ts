/**
 * 从宿主持久化会话读取消息历史。
 *
 * 活跃会话的最新消息可能还没落盘,所以调用方通常优先用注册表的内存历史;
 * 本模块负责「会话未激活 / resume 需要补齐」时的读取。
 */

import { textOf } from '../bridge/event-map.js'
import type { HostCtx } from '../bridge/agent-bridge.js'
import type { WireMessage } from './session-registry.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读宿主持久化会话的消息历史(仅 user/assistant 文本)。
 * 宿主无 sessionQuery(或读取失败)时返回空数组。
 */
export async function readPersistedHistory(
  host: HostCtx,
  sessionId: string,
  limit = 0,
): Promise<WireMessage[]> {
  const query = host.get('sessionQuery') as
    | { readSession?: (id: string) => Promise<unknown> }
    | undefined
  if (!query || typeof query.readSession !== 'function') return []

  let snapshot: { events?: unknown[] } | undefined
  try {
    snapshot = (await query.readSession.call(query, sessionId)) as { events?: unknown[] } | undefined
  } catch {
    // 尚未落盘 / 会话不存在:交给调用方回退
    return []
  }
  const events = Array.isArray(snapshot?.events) ? snapshot!.events : []
  const messages: WireMessage[] = []
  for (const raw of events) {
    if (!isRecord(raw) || typeof raw.type !== 'string') continue
    const data = isRecord(raw.data) ? raw.data : undefined
    if (!data) continue
    // 两种事件的 data 形状不同:
    //   user/message      → data 本身就是 UserMessage(content 在 data.content)
    //   assistant/message → data.message 才是 AssistantMessage
    const message = isRecord(data.message) ? data.message : data
    const ts = typeof raw.time === 'number' ? raw.time : Date.now()
    if (raw.type === 'user/message') {
      const text = textOf(message.content)
      if (text) messages.push({ role: 'user', text, ts, kind: 'session.user-message' })
    } else if (raw.type === 'assistant/message') {
      const text = textOf(message.content)
      if (text) messages.push({ role: 'assistant', text, ts, kind: 'assistant.message' })
    }
  }
  return limit > 0 ? messages.slice(-limit) : messages
}

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readPersistedHistory } from '../src/sessions/persisted-history.js'
import type { HostCtx } from '../src/bridge/agent-bridge.js'

function hostWith(sessionQuery: unknown): HostCtx {
  return {
    get: (key: string) => (key === 'sessionQuery' ? sessionQuery : undefined),
    on: () => {},
    off: () => {},
  }
}

describe('readPersistedHistory', () => {
  test('user/message 的 data 就是消息;assistant/message 的 data.message 才是消息', async () => {
    const events = [
      // 宿主真实形状:user 事件的 data 直接是 UserMessage
      { type: 'user/message', time: 10, data: { id: 'm1', role: 'user', content: [{ type: 'text', text: '问题一' }] } },
      // assistant 事件的 data 是 { turn, step, message }
      {
        type: 'assistant/message',
        time: 11,
        data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '回答一' }] } },
      },
      { type: 'turn/start', time: 12, data: { turn: 2 } }, // 非消息事件忽略
      { type: 'user/message', time: 13, data: { role: 'user', content: [{ type: 'text', text: '问题二' }] } },
    ]
    const query = { readSession: async () => ({ events }) }
    const messages = await readPersistedHistory(hostWith(query), 'sess-1')
    assert.deepEqual(
      messages.map((m) => [m.role, m.text]),
      [
        ['user', '问题一'],
        ['assistant', '回答一'],
        ['user', '问题二'],
      ],
    )
  })

  test('limit 取最近 N 条', async () => {
    const events = [
      { type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'a' }] } },
      { type: 'user/message', time: 2, data: { content: [{ type: 'text', text: 'b' }] } },
      { type: 'user/message', time: 3, data: { content: [{ type: 'text', text: 'c' }] } },
    ]
    const query = { readSession: async () => ({ events }) }
    const messages = await readPersistedHistory(hostWith(query), 'sess-1', 2)
    assert.deepEqual(messages.map((m) => m.text), ['b', 'c'])
  })

  test('宿主无 sessionQuery → 空数组', async () => {
    assert.deepEqual(await readPersistedHistory(hostWith(undefined), 'sess-1'), [])
  })

  test('readSession 抛错(未落盘)→ 空数组,不抛出', async () => {
    const query = {
      readSession: async () => {
        throw new Error('no persisted session')
      },
    }
    assert.deepEqual(await readPersistedHistory(hostWith(query), 'sess-1'), [])
  })

  test('空文本块被跳过', async () => {
    const events = [
      { type: 'user/message', time: 1, data: { content: [{ type: 'text', text: '' }] } },
      { type: 'user/message', time: 2, data: { content: [] } },
      { type: 'user/message', time: 3, data: { content: [{ type: 'text', text: '有内容' }] } },
    ]
    const query = { readSession: async () => ({ events }) }
    const messages = await readPersistedHistory(hostWith(query), 'sess-1')
    assert.deepEqual(messages.map((m) => m.text), ['有内容'])
  })
})

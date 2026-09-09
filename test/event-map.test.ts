import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mapSessionEvent, type SessionEventLike } from '../src/bridge/event-map.js'

describe('mapSessionEvent', () => {
  test('assistant/message:文本 + 工具调用 + reasoning 扁平化', () => {
    const event: SessionEventLike = {
      type: 'assistant/message',
      seq: 10,
      data: {
        turn: 1,
        step: 2,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: '先想一下' },
            { type: 'text', text: '我来调用工具' },
            { type: 'tool-call', id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' },
          ],
        },
      },
    }
    const payload = mapSessionEvent(event)
    assert.ok(payload)
    assert.equal(payload!.kind, 'assistant.message')
    assert.equal(payload!.text, '我来调用工具')
    assert.equal(payload!.reasoningText, '先想一下')
    assert.deepEqual(payload!.toolCalls, [{ id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' }])
    assert.equal(payload!.turn, 1)
    assert.equal(payload!.step, 2)
  })

  test('assistant/message:无文本时省略字段', () => {
    const event: SessionEventLike = {
      type: 'assistant/message',
      data: { message: { content: [] } },
    }
    const payload = mapSessionEvent(event)
    assert.ok(payload)
    assert.equal(payload!.kind, 'assistant.message')
    assert.equal('text' in payload!, false)
    assert.equal('toolCalls' in payload!, false)
  })

  test('assistant/chunk 原样透传 chunk', () => {
    const event: SessionEventLike = {
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '你' } },
    }
    const payload = mapSessionEvent(event)
    assert.ok(payload)
    assert.equal(payload!.kind, 'assistant.chunk')
    assert.deepEqual(payload!.chunk, { type: 'text-delta', index: 0, text: '你' })
  })

  test('tool/call 字段映射', () => {
    const event: SessionEventLike = {
      type: 'tool/call',
      data: { turn: 2, step: 1, callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' },
    }
    const payload = mapSessionEvent(event)
    assert.ok(payload)
    assert.equal(payload!.kind, 'tool.call')
    assert.equal(payload!.callId, 'c1')
    assert.equal(payload!.name, 'bash')
    assert.equal(payload!.arguments, '{"cmd":"ls"}')
  })

  test('tool/result:成功带文本', () => {
    const event: SessionEventLike = {
      type: 'tool/result',
      data: {
        turn: 2,
        step: 2,
        message: {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'file content' }] }],
        },
      },
    }
    const payload = mapSessionEvent(event)
    assert.ok(payload)
    assert.equal(payload!.kind, 'tool.result')
    assert.equal(payload!.callId, 'c1')
    assert.equal(payload!.ok, true)
    assert.equal(payload!.text, 'file content')
  })

  test('tool/result:失败(isError)时 ok=false', () => {
    const event: SessionEventLike = {
      type: 'tool/result',
      data: {
        message: {
          content: [
            {
              type: 'tool-result',
              toolCallId: 'c2',
              isError: true,
              content: [{ type: 'text', text: 'permission denied' }],
            },
          ],
        },
      },
    }
    const payload = mapSessionEvent(event)
    assert.ok(payload)
    assert.equal(payload!.kind, 'tool.result')
    assert.equal(payload!.callId, 'c2')
    assert.equal(payload!.ok, false)
    assert.equal(payload!.text, 'permission denied')
  })

  test('未识别/仅日志事件返回 null', () => {
    for (const type of ['user/message', 'turn/start', 'turn/end', 'step/start', 'request/header', 'approval/asked', 'something/future']) {
      assert.equal(mapSessionEvent({ type, data: {} }), null, `${type} should be ignored`)
    }
  })
})

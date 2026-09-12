import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mapSessionEvent, type SessionEventLike } from '../src/bridge/event-map.js'

/** 取映射结果里指定 kind 的载荷。 */
function pick(payloads: Record<string, unknown>[], kind: string) {
  return payloads.find((p) => p.kind === kind)
}

describe('mapSessionEvent', () => {
  test('assistant/message:思考先于正文推送', () => {
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
    const payloads = mapSessionEvent(event)
    assert.equal(payloads.length, 2)
    // 顺序:reasoning → message(客户端按此顺序渲染,思考区在正文之前)
    assert.equal(payloads[0]!.kind, 'assistant.reasoning')
    assert.equal(payloads[1]!.kind, 'assistant.message')

    const reasoning = payloads[0]!
    assert.equal(reasoning.text, '先想一下')
    assert.equal(reasoning.turn, 1)
    assert.equal(reasoning.step, 2)

    const message = payloads[1]!
    assert.equal(message.text, '我来调用工具')
    assert.deepEqual(message.toolCalls, [
      { id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' },
    ])
    // reasoning 已由独立的 assistant.reasoning 承载,不在正文里重复
    assert.equal('reasoningText' in message, false)
  })

  test('assistant/message:无文本/无思考时仍出正文占位', () => {
    const payloads = mapSessionEvent({ type: 'assistant/message', data: { message: { content: [] } } })
    assert.equal(payloads.length, 1)
    assert.equal(payloads[0]!.kind, 'assistant.message')
    assert.equal('text' in payloads[0]!, false)
    assert.equal('toolCalls' in payloads[0]!, false)
  })

  test('assistant/chunk:普通增量走 assistant.chunk', () => {
    const payloads = mapSessionEvent({
      type: 'assistant/chunk',
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '你' } },
    })
    assert.equal(payloads.length, 1)
    assert.equal(payloads[0]!.kind, 'assistant.chunk')
    assert.deepEqual(payloads[0]!.chunk, { type: 'text-delta', index: 0, text: '你' })
  })

  test('assistant/chunk:reasoning-delta 走独立 kind', () => {
    const payloads = mapSessionEvent({
      type: 'assistant/chunk',
      data: { turn: 2, step: 1, chunk: { type: 'reasoning-delta', index: 3, text: '嗯…' } },
    })
    assert.equal(payloads.length, 1)
    const payload = payloads[0]!
    assert.equal(payload.kind, 'assistant.reasoning-chunk')
    assert.equal(payload.text, '嗯…')
    assert.equal(payload.index, 3)
    assert.equal(payload.turn, 2)
  })

  test('tool/call 字段映射', () => {
    const payloads = mapSessionEvent({
      type: 'tool/call',
      data: { turn: 2, step: 1, callId: 'c1', name: 'bash', arguments: '{"cmd":"ls"}' },
    })
    const payload = pick(payloads, 'tool.call')!
    assert.ok(payload)
    assert.equal(payload.callId, 'c1')
    assert.equal(payload.name, 'bash')
    assert.equal(payload.arguments, '{"cmd":"ls"}')
  })

  test('tool/result:成功带文本', () => {
    const payloads = mapSessionEvent({
      type: 'tool/result',
      data: {
        turn: 2,
        step: 2,
        message: {
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'file content' }] }],
        },
      },
    })
    const payload = payloads[0]!
    assert.equal(payload.kind, 'tool.result')
    assert.equal(payload.callId, 'c1')
    assert.equal(payload.ok, true)
    assert.equal(payload.text, 'file content')
  })

  test('tool/result:失败(isError)时 ok=false', () => {
    const payloads = mapSessionEvent({
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
    })
    const payload = payloads[0]!
    assert.equal(payload.kind, 'tool.result')
    assert.equal(payload.ok, false)
    assert.equal(payload.text, 'permission denied')
  })

  describe('「当前在做什么」结构', () => {
    test('todo/write → session.todo', () => {
      const payloads = mapSessionEvent({
        type: 'todo/write',
        data: {
          todos: [
            { content: '读协议', status: 'completed' },
            { content: '写客户端', status: 'in_progress' },
          ],
        },
      })
      assert.equal(payloads.length, 1)
      assert.equal(payloads[0]!.kind, 'session.todo')
      assert.deepEqual(payloads[0]!.todos, [
        { content: '读协议', status: 'completed' },
        { content: '写客户端', status: 'in_progress' },
      ])
    })

    test('todo/write:形状不符的项被丢弃', () => {
      const payloads = mapSessionEvent({
        type: 'todo/write',
        data: { todos: [{ content: 'ok' }, { nope: 1 }, 'str'] },
      })
      assert.deepEqual(payloads[0]!.todos, [{ content: 'ok', status: 'pending' }])
    })

    test('plan/mode → session.plan(active)', () => {
      const payloads = mapSessionEvent({ type: 'plan/mode', data: { active: true } })
      assert.equal(payloads.length, 1)
      assert.equal(payloads[0]!.kind, 'session.plan')
      assert.equal(payloads[0]!.active, true)
    })

    test('turn/start 与 turn/end → session.turn', () => {
      const start = mapSessionEvent({ type: 'turn/start', data: { turn: 3 } })
      assert.deepEqual(start[0], { kind: 'session.turn', turn: 3, phase: 'start' })

      const end = mapSessionEvent({ type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
      assert.deepEqual(end[0], { kind: 'session.turn', turn: 3, phase: 'end', reason: 'completed' })
    })
  })

  test('未识别/仅日志事件返回空数组', () => {
    for (const type of ['user/message', 'step/start', 'step/end', 'request/header', 'approval/asked', 'something/future']) {
      assert.deepEqual(mapSessionEvent({ type, data: {} }), [], `${type} should be ignored`)
    }
  })

  test('缺失必需字段的事件不产出载荷', () => {
    assert.deepEqual(mapSessionEvent({ type: 'turn/start', data: {} }), [])
    assert.deepEqual(mapSessionEvent({ type: 'todo/write', data: { todos: 'nope' } }), [])
    assert.deepEqual(mapSessionEvent({ type: 'plan/mode', data: {} }), [])
  })
})

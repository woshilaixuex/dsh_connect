import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  ErrorCodes,
  parseFrame,
  resOk,
  resErr,
  evtFrame,
  errFrame,
  pongFrame,
} from '../src/protocol/frame.js'

/** 序列化后经 parseFrame 走一遍,等价于真实 socket 收到文本。 */
function roundTrip(obj: unknown) {
  return parseFrame(Buffer.from(JSON.stringify(obj)))
}

describe('parseFrame:合法帧', () => {
  test('req 帧带 payload', () => {
    const result = roundTrip({ v: 1, kind: 'req', id: 'a-1', code: 'agent.run', payload: { prompt: 'hi' } })
    assert.ok(result.ok)
    if (!result.ok) return
    assert.equal(result.frame.kind, 'req')
    if (result.frame.kind !== 'req') return
    assert.equal(result.frame.id, 'a-1')
    assert.equal(result.frame.code, 'agent.run')
    assert.deepEqual(result.frame.payload, { prompt: 'hi' })
  })

  test('req 帧可无 payload', () => {
    const result = roundTrip({ v: 1, kind: 'req', id: 'a-2', code: 'sys.noop' })
    assert.ok(result.ok)
    if (!result.ok || result.frame.kind !== 'req') return
    assert.equal('payload' in result.frame, false)
  })

  test('sub 帧带 add/remove', () => {
    const result = roundTrip({ v: 1, kind: 'sub', id: 's-1', add: ['task:1'], remove: ['task:0'] })
    assert.ok(result.ok)
    if (!result.ok || result.frame.kind !== 'sub') return
    assert.deepEqual(result.frame.add, ['task:1'])
    assert.deepEqual(result.frame.remove, ['task:0'])
    assert.equal(result.frame.id, 's-1')
  })

  test('空 sub 帧(无 add/remove)合法为 no-op', () => {
    const result = roundTrip({ v: 1, kind: 'sub' })
    assert.ok(result.ok)
  })

  test('ping 帧', () => {
    const result = roundTrip({ v: 1, kind: 'ping' })
    assert.ok(result.ok)
    if (!result.ok) return
    assert.equal(result.frame.kind, 'ping')
  })
})

describe('parseFrame:非法帧', () => {
  test('非法 JSON', () => {
    const result = parseFrame(Buffer.from('{not json'))
    assert.ok(!result.ok)
    if (!result.ok) assert.equal(result.code, ErrorCodes.BAD_FRAME)
  })

  test('顶层非对象', () => {
    for (const bad of ['[1,2]', '"str"', '123', 'null']) {
      const result = parseFrame(Buffer.from(bad))
      assert.ok(!result.ok, `should reject ${bad}`)
    }
  })

  test('协议版本不匹配', () => {
    const result = roundTrip({ v: 999, kind: 'ping' })
    assert.ok(!result.ok)
    if (!result.ok) assert.equal(result.code, ErrorCodes.BAD_FRAME)
  })

  test('未知 kind', () => {
    const result = roundTrip({ v: 1, kind: 'explode' })
    assert.ok(!result.ok)
    if (!result.ok) assert.equal(result.code, ErrorCodes.BAD_FRAME)
  })

  test('req 缺 id/code', () => {
    for (const frame of [{ v: 1, kind: 'req', code: 'x' }, { v: 1, kind: 'req', id: 'i' }, { v: 1, kind: 'req' }]) {
      assert.ok(!roundTrip(frame).ok)
    }
  })

  test('sub add/remove 含非字符串元素', () => {
    assert.ok(!roundTrip({ v: 1, kind: 'sub', add: ['ok', 42] }).ok)
    assert.ok(!roundTrip({ v: 1, kind: 'sub', add: 'not-array' }).ok)
  })

  test('超长帧回 bad.size', () => {
    const big = 'x'.repeat(MAX_FRAME_BYTES + 1)
    const result = parseFrame(Buffer.from(big))
    assert.ok(!result.ok)
    if (!result.ok) assert.equal(result.code, ErrorCodes.BAD_SIZE)
  })
})

describe('服务端帧构造器', () => {
  test('resOk 有/无 data', () => {
    assert.deepEqual(resOk('r1'), { v: 1, kind: 'res', id: 'r1', ok: true })
    assert.deepEqual(resOk('r2', { n: 1 }), { v: 1, kind: 'res', id: 'r2', ok: true, data: { n: 1 } })
  })

  test('resErr / errFrame / evtFrame / pongFrame', () => {
    assert.deepEqual(resErr('r', 'bad.request', 'msg'), { v: 1, kind: 'res', id: 'r', ok: false, code: 'bad.request', message: 'msg' })
    assert.deepEqual(errFrame('bad.frame', 'x'), { v: 1, kind: 'err', code: 'bad.frame', message: 'x' })
    const evt = evtFrame('topic', { a: 1 }, 1000)
    assert.deepEqual(evt, { v: 1, kind: 'evt', push: 'topic', data: { a: 1 }, ts: 1000 })
    assert.deepEqual(evtFrame('topic', undefined, 1), { v: 1, kind: 'evt', push: 'topic', ts: 1 })
    assert.deepEqual(pongFrame(), { v: PROTOCOL_VERSION, kind: 'pong' })
  })
})

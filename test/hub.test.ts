import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHub, TaskError } from '../src/hub/hub.js'
import { ErrorCodes, type ReqFrame } from '../src/protocol/frame.js'
import { FakeConn, makeLogger, tick } from './helpers.js'

let hub: ReturnType<typeof createHub>
let conn: FakeConn

beforeEach(() => {
  hub = createHub(makeLogger())
  conn = new FakeConn()
})

function req(id: string, code: string, payload?: unknown): ReqFrame {
  return { v: 1, kind: 'req', id, code, ...(payload === undefined ? {} : { payload: payload as never }) }
}

describe('接收器注册与分派', () => {
  test('handler 返回值作为 res ok data', async () => {
    hub.registerReceiver('echo', (payload) => payload)
    hub.dispatch(conn, req('r1', 'echo', { x: 1 }))
    await tick()
    assert.equal(conn.frames.length, 1)
    const frame = conn.frames[0]!
    assert.equal(frame.kind, 'res')
    if (frame.kind !== 'res' || !frame.ok) return
    assert.equal(frame.id, 'r1')
    assert.deepEqual(frame.data, { x: 1 })
  })

  test('handler 返回 undefined 时 res ok 不带 data', async () => {
    hub.registerReceiver('void', async () => undefined)
    hub.dispatch(conn, req('r2', 'void'))
    await tick()
    const frame = conn.frames[0]!
    assert.equal(frame.kind, 'res')
    if (frame.kind !== 'res') return
    assert.equal(frame.ok, true)
    assert.equal('data' in frame, false)
  })

  test('未知接收码回 unknown.code', async () => {
    hub.dispatch(conn, req('r3', 'no.such.code'))
    await tick()
    const frame = conn.frames[0]!
    assert.equal(frame.kind, 'res')
    if (frame.kind !== 'res' || frame.ok) return
    assert.equal(frame.code, ErrorCodes.UNKNOWN_CODE)
  })

  test('TaskError 映射为对应错误码', async () => {
    hub.registerReceiver('boom', () => {
      throw new TaskError(ErrorCodes.AGENT_NOT_FOUND, 'missing')
    })
    hub.dispatch(conn, req('r4', 'boom'))
    await tick()
    const frame = conn.frames[0]!
    assert.equal(frame.kind, 'res')
    if (frame.kind !== 'res' || frame.ok) return
    assert.equal(frame.code, ErrorCodes.AGENT_NOT_FOUND)
    assert.equal(frame.message, 'missing')
  })

  test('普通异常映射为 internal', async () => {
    hub.registerReceiver('explode', async () => {
      throw new Error('kaboom')
    })
    hub.dispatch(conn, req('r5', 'explode'))
    await tick()
    const frame = conn.frames[0]!
    assert.equal(frame.kind, 'res')
    if (frame.kind !== 'res' || frame.ok) return
    assert.equal(frame.code, ErrorCodes.INTERNAL)
    assert.equal(frame.message, 'kaboom')
  })

  test('重复注册同码抛错;注销后恢复 unknown', async () => {
    const disposer = hub.registerReceiver('dup', () => 'a')
    assert.throws(() => hub.registerReceiver('dup', () => 'b'), /already registered/)
    disposer()
    hub.dispatch(conn, req('r6', 'dup'))
    await tick()
    const frame = conn.frames[0]!
    assert.equal(frame.kind, 'res')
    if (frame.kind !== 'res' || frame.ok) return
    assert.equal(frame.code, ErrorCodes.UNKNOWN_CODE)
  })
})

describe('推送主题', () => {
  test('publish 只发给已订阅连接', async () => {
    const other = new FakeConn()
    hub.subscribe(conn, 'topic')
    hub.publish('topic', { n: 1 })
    hub.publish('other', { n: 2 })
    assert.equal(conn.frames.length, 1)
    assert.equal(other.frames.length, 0)
    const frame = conn.frames[0]!
    assert.equal(frame.kind, 'evt')
    if (frame.kind !== 'evt') return
    assert.equal(frame.push, 'topic')
    assert.deepEqual(frame.data, { n: 1 })
  })

  test('退订后不再收到;重复订阅幂等', () => {
    hub.subscribe(conn, 'topic')
    hub.subscribe(conn, 'topic')
    hub.unsubscribe(conn, 'topic')
    hub.publish('topic', {})
    assert.equal(conn.frames.length, 0)
  })

  test('多连接订阅都收到', () => {
    const other = new FakeConn()
    hub.subscribe(conn, 'topic')
    hub.subscribe(other, 'topic')
    hub.publish('topic', { ok: true })
    assert.equal(conn.frames.length, 1)
    assert.equal(other.frames.length, 1)
  })

  test('handler 内经 RecvCtx.subscribe 可让发起连接自动加入主题', async () => {
    hub.registerReceiver('enter', (_payload, ctx) => {
      ctx.subscribe('auto.topic')
      return 'joined'
    })
    hub.dispatch(conn, req('r', 'enter'))
    await tick()
    assert.equal(conn.frames.length, 1) // 只有 res,还没有 evt
    hub.publish('auto.topic', { evt: true })
    assert.equal(conn.frames.length, 2)
    const evt = conn.frames[1]!
    assert.equal(evt.kind, 'evt')
    if (evt.kind !== 'evt') return
    assert.equal(evt.push, 'auto.topic')
  })
})

describe('连接清理与断开回调', () => {
  test('clearConn 触发 onClose 回调并清空订阅', async () => {
    hub.subscribe(conn, 'topic')
    let called = 0
    const disposer = hub.onConnClose(conn, () => called++)
    hub.clearConn(conn)
    assert.equal(called, 1)
    disposer() // 已触发,注销无副作用
    hub.publish('topic', {})
    assert.equal(conn.frames.length, 0)
  })

  test('clearConn 幂等:第二次不再触发回调', () => {
    let called = 0
    hub.onConnClose(conn, () => called++)
    hub.clearConn(conn)
    hub.clearConn(conn)
    assert.equal(called, 1)
  })

  test('注销的断开回调不再触发', () => {
    let called = 0
    const disposer = hub.onConnClose(conn, () => called++)
    disposer()
    hub.clearConn(conn)
    assert.equal(called, 0)
  })
})

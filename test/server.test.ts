import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import type { Context } from '@deepseek-ai/cordis'
import { LogLevel } from '../src/log/logger.js'
import { createServer, type ProxyServer } from '../src/server/server.js'
import { ErrorCodes } from '../src/protocol/frame.js'
import { makeLogger } from './helpers.js'

/** 帧级接收器:缓冲 + 等待队列,recv 可精确匹配后续到来的帧。 */
function makeSink(ws: WebSocket) {
  interface Waiter {
    pred: (frame: unknown) => boolean
    resolve: (frame: unknown) => void
    timer: NodeJS.Timeout
  }
  const buffer: unknown[] = []
  const waiters = new Set<Waiter>()
  ws.on('message', (data) => {
    const frame: unknown = JSON.parse(String(data))
    for (const waiter of [...waiters]) {
      if (waiter.pred(frame)) {
        clearTimeout(waiter.timer)
        waiters.delete(waiter)
        waiter.resolve(frame)
        return
      }
    }
    buffer.push(frame)
  })
  return {
    /** 等下一个满足 pred 的帧。 */
    recv(pred: (frame: unknown) => boolean, timeoutMs = 3000): Promise<unknown> {
      const idx = buffer.findIndex(pred)
      if (idx >= 0) return Promise.resolve(buffer.splice(idx, 1)[0])
      return new Promise((resolve, reject) => {
        const waiter: Waiter = {
          pred,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter)
            reject(new Error('timeout waiting for frame'))
          }, timeoutMs),
        }
        waiters.add(waiter)
      })
    },
    /** 断言一段时间内没有新帧。 */
    recvNone(ms = 200): Promise<boolean> {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          clearTimeout(timer)
          resolve(true)
        }, ms)
        ws.once('message', () => {
          clearTimeout(timer)
          resolve(false)
        })
      })
    },
  }
}

function fakeCtx(): unknown {
  return {
    logger: () => makeLogger(),
    get: () => undefined,
    on() {},
    off() {},
  }
}

let server: ProxyServer
let ws: WebSocket | undefined

beforeEach(async () => {
  const ctx = fakeCtx() as Context
  server = createServer(ctx, { hostName: '127.0.0.1', listenPort: 0, logLevel: LogLevel.DEV })
  const port = await server.port
  ws = new WebSocket(`ws://127.0.0.1:${port}`)
  await new Promise<void>((resolve, reject) => {
    ws!.once('open', () => resolve())
    ws!.once('error', reject)
  })
})

afterEach(async () => {
  ws?.close()
  await server?.dispose()
})

describe('server e2e(真实 ws 连接)', () => {
  test('ping → pong', async () => {
    ws!.send(JSON.stringify({ v: 1, kind: 'ping' }))
    const frame = await makeSink(ws!).recv((f: unknown) => (f as { kind?: string }).kind === 'pong')
    assert.deepEqual(frame, { v: 1, kind: 'pong' })
  })

  test('未知接收码回 res ok:false unknown.code', async () => {
    ws!.send(JSON.stringify({ v: 1, kind: 'req', id: 'u1', code: 'no.such.code' }))
    const frame = (await makeSink(ws!).recv(
      (f) => (f as { kind?: string }).kind === 'res' && (f as { id?: string }).id === 'u1',
    )) as { ok: boolean; code: string }
    assert.equal(frame.ok, false)
    assert.equal(frame.code, ErrorCodes.UNKNOWN_CODE)
  })

  test('非法 JSON 回帧级 err bad.frame', async () => {
    ws!.send('{broken json')
    const frame = (await makeSink(ws!).recv((f) => (f as { kind?: string }).kind === 'err')) as { code: string }
    assert.equal(frame.code, ErrorCodes.BAD_FRAME)
  })

  test('二进制帧回帧级 err', async () => {
    ws!.send(Buffer.from('not text'))
    const frame = (await makeSink(ws!).recv((f) => (f as { kind?: string }).kind === 'err')) as { code: string }
    assert.equal(frame.code, ErrorCodes.BAD_FRAME)
  })

  test('sub(带 id)→ res ok;之后 publish 的 evt 到达;退订后不再到达', async () => {
    const sink = makeSink(ws!)

    ws!.send(JSON.stringify({ v: 1, kind: 'sub', id: 's1', add: ['topic.demo'] }))
    await sink.recv((f) => (f as { kind?: string }).kind === 'res' && (f as { id?: string }).id === 's1')

    server.hub.publish('topic.demo', { hello: 1 })
    const evt = (await sink.recv((f) => (f as { kind?: string }).kind === 'evt')) as {
      push: string
      data: { hello: number }
      ts: number
    }
    assert.equal(evt.push, 'topic.demo')
    assert.deepEqual(evt.data, { hello: 1 })
    assert.equal(typeof evt.ts, 'number')

    ws!.send(JSON.stringify({ v: 1, kind: 'sub', id: 's2', remove: ['topic.demo'] }))
    await sink.recv((f) => (f as { kind?: string }).kind === 'res' && (f as { id?: string }).id === 's2')

    server.hub.publish('topic.demo', { again: true })
    assert.equal(await sink.recvNone(), true)
  })

  test('未订阅的推送码不投递', async () => {
    const sink = makeSink(ws!)
    server.hub.publish('never.subscribed', { n: 1 })
    assert.equal(await sink.recvNone(), true)
  })

  test('server.hub 注册接收器后 req → res ok data', async () => {
    server.hub.registerReceiver('echo', (payload) => payload)
    ws!.send(JSON.stringify({ v: 1, kind: 'req', id: 'e1', code: 'echo', payload: { x: 1 } }))
    const frame = (await makeSink(ws!).recv(
      (f) => (f as { kind?: string }).kind === 'res' && (f as { id?: string }).id === 'e1',
    )) as { ok: boolean; data: { x: number } }
    assert.equal(frame.ok, true)
    assert.deepEqual(frame.data, { x: 1 })
  })

  test('无宿主 agent 服务时 agent.run 回 host.unavailable', async () => {
    ws!.send(JSON.stringify({ v: 1, kind: 'req', id: 'a1', code: 'agent.run', payload: { prompt: 'hi' } }))
    const frame = (await makeSink(ws!).recv(
      (f) => (f as { kind?: string }).kind === 'res' && (f as { id?: string }).id === 'a1',
    )) as { ok: boolean; code: string }
    assert.equal(frame.ok, false)
    assert.equal(frame.code, ErrorCodes.HOST_UNAVAILABLE)
  })
})

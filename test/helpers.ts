/** 测试共享工具:假 logger、假连接、事件循环推进。 */

import type { ConnectionHandle, LoggerLike } from '../src/hub/hub.js'
import type { S2C } from '../src/protocol/frame.js'

let connSeq = 0

/** 无副作用的 logger 桩。 */
export function makeLogger(): LoggerLike {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
  }
}

/** 假连接:记录收到的帧;closed 后 send 静默丢弃(模拟真实 socket 关闭行为)。 */
export class FakeConn implements ConnectionHandle {
  readonly id: string
  closed = false
  readonly frames: S2C[] = []

  constructor(id?: string) {
    this.id = id ?? `conn-${++connSeq}`
  }

  send(frame: S2C): void {
    if (this.closed) return
    this.frames.push(frame)
  }

  close(): void {
    this.closed = true
  }
}

/** 等待若干事件循环,让异步分派(dispatch → handler → res)落定。 */
export function tick(times = 3): Promise<void> {
  let chain: Promise<void> = Promise.resolve()
  for (let i = 0; i < times; i++) {
    chain = chain.then(() => new Promise<void>((resolve) => setImmediate(resolve)))
  }
  return chain
}

/**
 * dsh-connect 连通性冒烟脚本(参考客户端,零依赖)。
 *
 * 用 Node 22+ 内置的全局 WebSocket,不需要 npm install,可直接拷到任意机器验证服务端。
 * 用途:在写/调客户端逻辑之前,先确认「协议通、宿主 agent 能跑」。
 *
 * 用法:
 *   node smoke.mjs                                  # 协议检查 + 真实 agent.run
 *   node smoke.mjs --no-agent                       # 只跑协议检查(不触发宿主推理/不耗 token)
 *   node smoke.mjs ws://192.168.1.10:8080           # 指定地址
 *   SMOKE_URL=ws://host:port SMOKE_PROMPT="你好" node smoke.mjs
 *   SMOKE_AGENT_TIMEOUT=300000 node smoke.mjs       # agent 超时(ms)
 *
 * 退出码:0 = 全部通过;1 = 有失败项或连接异常。
 */

const argUrl = process.argv.find((a) => a.startsWith('ws://') || a.startsWith('wss://'))
const URL = argUrl ?? process.env.SMOKE_URL ?? 'ws://127.0.0.1:8097'
const SKIP_AGENT = process.argv.includes('--no-agent')
const AGENT_TIMEOUT_MS = Number(process.env.SMOKE_AGENT_TIMEOUT ?? 180_000)

const MAX_FRAME_BYTES = 256 * 1024

let pass = 0
let fail = 0

function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  \u2713 ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * 帧路由:收到的帧先按判定函数投递给等待者,无处可投则缓冲。
 * 这是个最小实现,展示客户端该怎么按 id / push / kind 分流。
 */
function makeRouter(socket) {
  const buffer = []
  const waiters = new Set()

  socket.addEventListener('message', (event) => {
    let frame
    try {
      frame = JSON.parse(String(event.data))
    } catch {
      console.log('  (收到非 JSON 帧,已忽略)')
      return
    }
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
    /** 等下一个满足 pred 的帧;已缓冲的优先。 */
    recv(pred, timeoutMs = 5000) {
      const idx = buffer.findIndex(pred)
      if (idx >= 0) return Promise.resolve(buffer.splice(idx, 1)[0])
      return new Promise((resolve, reject) => {
        const waiter = {
          pred,
          resolve,
          timer: setTimeout(() => {
            waiters.delete(waiter)
            reject(new Error('等待帧超时'))
          }, timeoutMs),
        }
        waiters.add(waiter)
      })
    },
    /** 等某请求 id 的 res。 */
    res(id, timeoutMs) {
      return this.recv((f) => f.kind === 'res' && f.id === id, timeoutMs)
    },
  }
}

/** 建连接(失败/超时即 reject)。 */
function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => reject(new Error('连接超时')), 10_000)
    socket.addEventListener('open', () => {
      clearTimeout(timer)
      resolve(socket)
    }, { once: true })
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('连接失败'))
    }, { once: true })
  })
}

/** 发一帧(顺带做帧大小自查)。 */
function send(socket, frame) {
  const text = JSON.stringify(frame)
  if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) {
    throw new Error(`帧超过 ${MAX_FRAME_BYTES} 字节上限`)
  }
  socket.send(text)
}

async function main() {
  console.log(`\n连接 ${URL} ...`)
  const socket = await connect(URL)
  socket.addEventListener('close', (e) => {
    console.log(`\n(连接已关闭 code=${e.code} reason=${e.reason || '-'})`)
  })
  const router = makeRouter(socket)
  console.log('已连接\n')

  // ── 协议检查 ────────────────────────────────────────────────────────────────

  console.log('[1] ping → pong')
  send(socket, { v: 1, kind: 'ping' })
  const pong = await router.recv((f) => f.kind === 'pong')
  check('收到 pong', pong.kind === 'pong')

  console.log('\n[2] 未知接收码 → res ok:false unknown.code')
  send(socket, { v: 1, kind: 'req', id: 'smoke-unknown', code: 'no.such.code' })
  const unknown = await router.res('smoke-unknown')
  check('ok:false + unknown.code', unknown.ok === false && unknown.code === 'unknown.code', String(unknown.code))

  console.log('\n[3] 非法 JSON → 帧级 err(连接不断开)')
  socket.send('{broken json')
  const badFrame = await router.recv((f) => f.kind === 'err')
  check('收到 bad.frame', badFrame.code === 'bad.frame', String(badFrame.code))
  send(socket, { v: 1, kind: 'ping' })
  const pong2 = await router.recv((f) => f.kind === 'pong')
  check('收到 err 后连接仍可用', pong2.kind === 'pong')

  console.log('\n[4] sub 订阅 / 退订(带 id 会回 res ok)')
  send(socket, { v: 1, kind: 'sub', id: 'smoke-sub', add: ['task:smoke-nonexistent'] })
  const subAck = await router.res('smoke-sub')
  check('订阅确认 res ok', subAck.ok === true)
  send(socket, { v: 1, kind: 'sub', id: 'smoke-unsub', remove: ['task:smoke-nonexistent'] })
  const unsubAck = await router.res('smoke-unsub')
  check('退订确认 res ok', unsubAck.ok === true)

  // ── 端到端 ─────────────────────────────────────────────────────────────────

  if (SKIP_AGENT) {
    console.log('\n(--no-agent:跳过 agent.run)\n')
  } else {
    console.log('\n[5] 端到端:agent.run → 事件流 → 最终 res')
    const prompt = process.env.SMOKE_PROMPT ?? '请只回复两个字:收到'
    const startedAt = Date.now()
    console.log(`  prompt: ${JSON.stringify(prompt)}`)

    const seen = new Map()
    socket.addEventListener('message', (event) => {
      let frame
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (frame.kind !== 'evt') return
      const kind = frame.data?.kind ?? '(无 kind)'
      seen.set(kind, (seen.get(kind) ?? 0) + 1)
      if (kind === 'assistant.message') {
        console.log(`  ← assistant.message: ${JSON.stringify(frame.data.text ?? '')}`)
      } else if (kind === 'tool.call') {
        console.log(`  ← tool.call: ${frame.data.name}`)
      } else if (kind === 'tool.result') {
        console.log(`  ← tool.result: ok=${frame.data.ok}`)
      } else if (kind === 'assistant.chunk') {
        // 默认不推;chunks:true 时才有
      } else {
        console.log(`  ← ${kind}: ${JSON.stringify(frame.data).slice(0, 160)}`)
      }
    })

    send(socket, { v: 1, kind: 'req', id: 'smoke-run', code: 'agent.run', payload: { prompt, chunks: false } })
    const fin = await router.res('smoke-run', AGENT_TIMEOUT_MS)
    const elapsed = Date.now() - startedAt

    if (fin.ok) {
      console.log(`\n  完成: ${JSON.stringify(fin.data)}`)
      check('res ok', true, `${elapsed}ms`)
      check('返回 taskId', typeof fin.data?.taskId === 'string', String(fin.data?.taskId))
      check('status 为 done/stopped/failed', ['done', 'stopped', 'failed'].includes(fin.data?.status), String(fin.data?.status))
      check('收到事件流', seen.size > 0, [...seen.entries()].map(([k, v]) => `${k}×${v}`).join(', '))
      if (fin.data?.status === 'done') {
        check('含 assistant.message', seen.has('assistant.message'))
      } else {
        console.log(`  (status=${fin.data?.status}, error=${fin.data?.error ?? '-'})`)
      }
    } else {
      check('agent.run 成功', false, `${fin.code}: ${fin.message}`)
    }
  }

  socket.close()
  console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`\n脚本失败: ${error.message}`)
  console.error('排查:服务端是否启动?地址/端口是否正确?见 SKILL.md「故障对照表」。')
  process.exit(1)
})

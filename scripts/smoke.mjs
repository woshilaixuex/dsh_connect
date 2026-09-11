/**
 * dsh-connect 冒烟脚本:连真实 dsh 宿主,端到端验证 WS 协议 + agent 桥接。
 *
 * 用法(在插件目录跑,服务需已启动):
 *   node scripts/smoke.mjs                     # 协议检查 + 真实 agent.run
 *   node scripts/smoke.mjs --no-agent          # 只跑协议检查(不触发宿主推理)
 *   DSH_CONNECT_SMOKE_URL=ws://127.0.0.1:8097 node scripts/smoke.mjs
 */

import WebSocket from 'ws'

const URL = process.env.DSH_CONNECT_SMOKE_URL ?? 'ws://127.0.0.1:8080'
const SKIP_AGENT = process.argv.includes('--no-agent')
const AGENT_TIMEOUT_MS = Number(process.env.SMOKE_AGENT_TIMEOUT ?? 180_000)

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 帧路由:收到即按判定函数投递给等待者,否则缓冲。 */
function makeRouter(ws) {
  const buffer = []
  const waiters = new Set()
  ws.on('message', (raw) => {
    let frame
    try {
      frame = JSON.parse(String(raw))
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
    /** 等下一个满足 pred 的帧。 */
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
    /** 等 res 帧(按 id)。 */
    res(id, timeoutMs) {
      return this.recv((f) => f.kind === 'res' && f.id === id, timeoutMs)
    },
    /** 是否有缓存帧满足 pred(不消费)。 */
    peek(pred) {
      return buffer.some(pred)
    },
  }
}

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

async function main() {
  console.log(`\n连接 ${URL} ...`)
  const ws = await open(URL)
  const router = makeRouter(ws)
  console.log('已连接\n')

  console.log('[1] 协议:ping → pong')
  ws.send(JSON.stringify({ v: 1, kind: 'ping' }))
  const pong = await router.recv((f) => f.kind === 'pong')
  check('收到 pong', pong.kind === 'pong')

  console.log('\n[2] 协议:未知接收码 → res ok:false unknown.code')
  ws.send(JSON.stringify({ v: 1, kind: 'req', id: 'u1', code: 'no.such.code' }))
  const unknown = await router.res('u1')
  check('ok:false + unknown.code', unknown.ok === false && unknown.code === 'unknown.code', `${unknown.code}`)

  console.log('\n[3] 协议:非法 JSON → 帧级 err(bad.frame,不断连)')
  ws.send('{broken json')
  const badFrame = await router.recv((f) => f.kind === 'err')
  check('收到 bad.frame', badFrame.code === 'bad.frame', badFrame.code)

  console.log('\n[4] 协议:sub 订阅 / 收推送 / 退订')
  ws.send(JSON.stringify({ v: 1, kind: 'sub', id: 's1', add: ['smoke.topic'] }))
  const subOk = await router.res('s1')
  check('订阅确认 res ok', subOk.ok === true)
  // 自己往 hub 推不了(推送由服务端触发),只能验证订阅/退订协议本身
  ws.send(JSON.stringify({ v: 1, kind: 'sub', id: 's2', remove: ['smoke.topic'] }))
  const unsubOk = await router.res('s2')
  check('退订确认 res ok', unsubOk.ok === true)

  if (SKIP_AGENT) {
    console.log('\n(--no-agent:跳过 agent.run 实测)\n')
  } else {
    console.log('\n[5] 端到端:agent.run → 事件流 → 最终 res')
    const prompt = process.env.SMOKE_PROMPT ?? '请只回复两个字:收到'
    console.log(`  prompt: ${JSON.stringify(prompt)}`)
    const startedAt = Date.now()
    ws.send(JSON.stringify({
      v: 1, kind: 'req', id: 'r1', code: 'agent.run',
      payload: { prompt, chunks: false },
    }))

    const seen = new Map()
    let firstEventLogged = false
    const collect = (f) => {
      if (f.kind === 'evt') {
        const kind = f.data?.kind ?? '(无 kind)'
        seen.set(kind, (seen.get(kind) ?? 0) + 1)
        if (!firstEventLogged) {
          firstEventLogged = true
          console.log(`  ← 首个事件 @${Date.now() - startedAt}ms  push=${f.push}`)
        }
        if (kind === 'assistant.message') {
          console.log(`  ← assistant.message: ${JSON.stringify(f.data.text ?? '')}`)
        } else if (kind === 'tool.call') {
          console.log(`  ← tool.call: ${f.data.name}`)
        } else if (kind !== 'assistant.chunk') {
          console.log(`  ← ${kind}: ${JSON.stringify(f.data).slice(0, 160)}`)
        }
      }
    }
    ws.on('message', (raw) => {
      try { collect(JSON.parse(String(raw))) } catch { /* 已由 router 处理 */ }
    })

    const fin = await router.res('r1', AGENT_TIMEOUT_MS)
    const elapsed = Date.now() - startedAt

    if (fin.ok) {
      console.log(`\n  完成: ${JSON.stringify(fin.data)}`)
      check('res ok', true, `${elapsed}ms`)
      check('返回 taskId', typeof fin.data?.taskId === 'string', fin.data?.taskId)
      check('status = done', fin.data?.status === 'done', fin.data?.status)
      check('收到事件流', seen.size > 0, [...seen.entries()].map(([k, v]) => `${k}×${v}`).join(', '))
      check('含 assistant.message', seen.has('assistant.message'))
    } else {
      check('agent.run 成功', false, `${fin.code}: ${fin.message}`)
    }
  }

  ws.close()
  console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`\n脚本失败: ${error.message}`)
  process.exit(1)
})

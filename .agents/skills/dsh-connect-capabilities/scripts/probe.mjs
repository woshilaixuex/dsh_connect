/**
 * dsh-connect 能力探针(零依赖,Node 22+ 全局 WebSocket)。
 *
 * 回答一个问题:**当前这个正在跑的 dsh-connect,哪些能力是活的?**
 * 与 smoke.mjs(通过/失败测试)不同,本题只做「能力存在性」探测,**不触发真实推理**。
 *
 * 用法:
 *   node probe.mjs                       # 默认 ws://127.0.0.1:8097
 *   node probe.mjs ws://192.168.1.10:8080
 *   PROBE_URL=ws://host:port node probe.mjs
 *
 * 退出码:0 = 传输+协议+分派器都在;1 = 有探测失败或连不上。
 */

const argUrl = process.argv.find((a) => a.startsWith('ws://') || a.startsWith('wss://'))
const URL = argUrl ?? process.env.PROBE_URL ?? 'ws://127.0.0.1:8097'

let bad = 0

function ok(label, detail = '') {
  console.log(`  \u2713 ${label}${detail ? ` — ${detail}` : ''}`)
}
function no(label, detail = '') {
  bad++
  console.log(`  \u2717 ${label}${detail ? ` — ${detail}` : ''}`)
}
function info(label, detail = '') {
  console.log(`  \u2022 ${label}${detail ? ` — ${detail}` : ''}`)
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => reject(new Error('连接超时(10s)')), 10_000)
    const onOpen = () => {
      clearTimeout(timer)
      socket.removeEventListener('error', onError)
      resolve(socket)
    }
    const onError = () => {
      clearTimeout(timer)
      socket.removeEventListener('open', onOpen)
      reject(new Error('连接失败'))
    }
    socket.addEventListener('open', onOpen)
    socket.addEventListener('error', onError)
  })
}

function makeRouter(socket) {
  const buffer = []
  const waiters = new Set()
  socket.addEventListener('message', (event) => {
    let frame
    try {
      frame = JSON.parse(String(event.data))
    } catch {
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
    res(id) {
      return this.recv((f) => f.kind === 'res' && f.id === id)
    },
  }
}

async function main() {
  console.log(`\ndsh-connect 能力探针 — ${URL}\n`)

  // 1. 传输层
  let socket
  try {
    socket = await connect(URL)
    ok('transport', 'WebSocket 已连接')
  } catch (error) {
    no('transport', error.message)
    console.log('\n服务端没在跑或地址不对。启动:dsh 根目录 pnpm dsh --profile dev-connect;')
    console.log('端口以日志 `ws server listening on <host>:<port>` 为准(默认 8097,常被 .env 覆盖)。\n')
    process.exit(1)
  }

  const router = makeRouter(socket)
  socket.addEventListener('close', (e) => console.log(`\n(连接已关闭 code=${e.code})`))

  // 2. 协议版本
  socket.send(JSON.stringify({ v: 1, kind: 'ping' }))
  try {
    const pong = await router.recv((f) => f.kind === 'pong')
    ok('protocol', `v1 握手正常(pong,kind=${pong.kind})`)
  } catch {
    no('protocol', '未收到 pong')
  }

  // 3. 帧级容错(坏帧回 err 且不断连)
  socket.send('{probe-broken')
  try {
    const err = await router.recv((f) => f.kind === 'err')
    ok('frame-error-handling', `坏帧回 ${err.code}(连接保持)`)
  } catch {
    no('frame-error-handling', '坏帧未回 err')
  }

  // 4. 请求分派器
  socket.send(JSON.stringify({ v: 1, kind: 'req', id: 'probe-unknown', code: 'probe.no.such.code' }))
  try {
    const res = await router.res('probe-unknown')
    if (res.ok === false && res.code === 'unknown.code') ok('dispatcher', '未知接收码回 unknown.code')
    else no('dispatcher', `异常响应 ${JSON.stringify(res)}`)
  } catch {
    no('dispatcher', '未收到响应')
  }

  // 5. 订阅机制(带 id 会回 res ok)
  socket.send(JSON.stringify({ v: 1, kind: 'sub', id: 'probe-sub', add: ['probe.nonexistent.topic'] }))
  try {
    const res = await router.res('probe-sub')
    if (res.ok === true) ok('subscription', 'sub 订阅/退订可用(res ok)')
    else no('subscription', `异常响应 ${JSON.stringify(res)}`)
  } catch {
    no('subscription', '未收到订阅确认')
  }

  // 6. 接收码 agent.stop(用一个不存在的 taskId 探测,无副作用)
  socket.send(JSON.stringify({ v: 1, kind: 'req', id: 'probe-stop', code: 'agent.stop', payload: { taskId: 'probe-nonexistent' } }))
  try {
    const res = await router.res('probe-stop')
    if (res.code === 'agent.not.found') ok('receiver:agent.stop', '已注册(任务不存在 → agent.not.found)')
    else if (res.code === 'unknown.code') no('receiver:agent.stop', '未注册(服务端没挂 agent 任务接收器)')
    else info('receiver:agent.stop', `响应 ${res.code ?? JSON.stringify(res.data)}`)
  } catch {
    no('receiver:agent.stop', '未收到响应')
  }

  // 7. 接收码 agent.run(空 payload 只会触发参数校验,不触发推理)
  socket.send(JSON.stringify({ v: 1, kind: 'req', id: 'probe-run', code: 'agent.run', payload: {} }))
  try {
    const res = await router.res('probe-run')
    if (res.code === 'bad.request') ok('receiver:agent.run', '已注册(缺 prompt → bad.request)')
    else if (res.code === 'unknown.code') no('receiver:agent.run', '未注册')
    else info('receiver:agent.run', `响应 ${res.code ?? JSON.stringify(res.data)}`)
  } catch {
    no('receiver:agent.run', '未收到响应')
  }

  // 8. 接收码 session.list(只读探测,无副作用)
  socket.send(JSON.stringify({ v: 1, kind: 'req', id: 'probe-sessions', code: 'session.list', payload: {} }))
  try {
    const res = await router.res('probe-sessions')
    if (res.ok === true) {
      const count = Array.isArray(res.data?.sessions) ? res.data.sessions.length : 0
      ok('receiver:session.list', `会话能力在线(${count} 个会话)`)
    } else if (res.code === 'unknown.code') {
      no('receiver:session.list', '会话能力未注册(需宿主 agent 服务 + 新版本插件)')
    } else {
      info('receiver:session.list', `响应 ${res.code}`)
    }
  } catch {
    no('receiver:session.list', '未收到响应')
  }

  // 9. 接收码 session.send(用不存在的会话探测,不触发推理)
  socket.send(
    JSON.stringify({ v: 1, kind: 'req', id: 'probe-session-send', code: 'session.send', payload: { sessionId: 'probe-nonexistent', prompt: 'x' } }),
  )
  try {
    const res = await router.res('probe-session-send')
    if (res.code === 'session.not.found') ok('receiver:session.send', '已注册(会话不存在 → session.not.found)')
    else if (res.code === 'unknown.code') no('receiver:session.send', '未注册')
    else info('receiver:session.send', `响应 ${res.code ?? JSON.stringify(res.data)}`)
  } catch {
    no('receiver:session.send', '未收到响应')
  }

  // 10. 接收码 workspace.list(只读探测;报告走的是 registry 还是 cwd 兜底)
  socket.send(JSON.stringify({ v: 1, kind: 'req', id: 'probe-workspaces', code: 'workspace.list', payload: {} }))
  try {
    const res = await router.res('probe-workspaces')
    if (res.ok === true) {
      const count = Array.isArray(res.data?.workspaces) ? res.data.workspaces.length : 0
      ok('receiver:workspace.list', `已注册,source=${res.data?.source}(${count} 个工作区)`)
      if (res.data?.source === 'cwd') {
        info('workspace 提示', '宿主未挂 @deepseek-ai/dsh-workspace(bundle 里没有)→ 已按 cwd 兜底分组')
      }
    } else if (res.code === 'unknown.code') {
      no('receiver:workspace.list', '未注册')
    } else {
      info('receiver:workspace.list', `响应 ${res.code}`)
    }
  } catch {
    no('receiver:workspace.list', '未收到响应')
  }

  socket.close()

  console.log('\n  说明:')
  info('host agent 可用性', '本探针不触发推理;要确认宿主 agent 真能跑,执行 dsh-connect-client/scripts/smoke.mjs(不加 --no-agent)')
  info('会话多轮上下文', '本探针只验接收器在册;要验证「记得上文」执行 dsh-connect-client/scripts/session-smoke.mjs')
  info('日志/存储/配置', '属进程启动期能力,不体现在 WS 上;见 SKILL.md「逐项接入方式」')
  console.log(`\n结果: ${bad === 0 ? '核心能力在线' : `${bad} 项探测失败`}\n`)
  process.exit(bad === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`\n探针失败: ${error.message}\n`)
  process.exit(1)
})

/**
 * dsh-connect 会话能力端到端冒烟(零依赖,Node 22+ 全局 WebSocket)。
 *
 * 验证「多轮上下文」是真的:第一轮告诉它一个名字,第二轮问它记不记得。
 * 这是客户端实现会话功能前最该先跑通的脚本 —— 它同时演示了会话族的正确用法。
 *
 * 用法:
 *   node session-smoke.mjs                              # 默认 ws://127.0.0.1:8097
 *   node session-smoke.mjs ws://192.168.1.10:8080
 *   SESSION_SMOKE_URL=ws://host:port node session-smoke.mjs
 *
 * 可选:验证「空闲回收后 resume 恢复上下文」(核心风险点)
 *   服务端设短回收阈值(如 DSH_CONNECT_SESSION_IDLE_MS=5000),
 *   再给本脚本设更大的等待:SMOKE_IDLE_WAIT_MS=8000 node session-smoke.mjs
 *
 * 退出码:0 = 全部通过;1 = 有失败项。
 */

const argUrl = process.argv.find((a) => a.startsWith('ws://') || a.startsWith('wss://'))
const URL = argUrl ?? process.env.SESSION_SMOKE_URL ?? 'ws://127.0.0.1:8097'
const TURN_TIMEOUT_MS = Number(process.env.SESSION_SMOKE_TIMEOUT ?? 180_000)

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

function info(label, detail = '') {
  console.log(`  \u2022 ${label}${detail ? ` — ${detail}` : ''}`)
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
    recv(pred, timeoutMs = 10_000) {
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
    res(id, timeoutMs) {
      return this.recv((f) => f.kind === 'res' && f.id === id, timeoutMs)
    },
  }
}

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

let seq = 0
function send(socket, kind, fields) {
  const id = `smoke-${++seq}`
  socket.send(JSON.stringify({ v: 1, kind, id, ...fields }))
  return id
}

/** 发一个 req 并等 res。 */
async function request(socket, router, code, payload, timeoutMs = 30_000) {
  const id = send(socket, 'req', { code, ...(payload === undefined ? {} : { payload }) })
  return router.res(id, timeoutMs)
}

/** 收集某会话主题上出现的事件载荷(客户端「按 push 分主题」的做法)。 */
function trackSessionEvents(socket, sessionId) {
  const seen = []
  socket.addEventListener('message', (event) => {
    let frame
    try {
      frame = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (frame.kind !== 'evt' || frame.push !== `session:${sessionId}`) return
    seen.push(frame.data)
  })
  return seen
}

/** 取最近一条助手回复文本。 */
function lastAssistantText(events) {
  return [...events].reverse().find((d) => d.kind === 'assistant.message')?.text
}

async function main() {
  console.log(`\ndsh-connect 会话冒烟 — ${URL}\n`)
  const socket = await connect(URL)
  const router = makeRouter(socket)
  console.log('已连接\n')

  // ── 1. 创建会话 ───────────────────────────────────────────────────────────
  console.log('[1] session.create')
  const created = await request(socket, router, 'session.create', { title: '冒烟测试会话' }, TURN_TIMEOUT_MS)
  if (!created.ok) {
    check('创建会话', false, `${created.code}: ${created.message}`)
    console.log('\n若为 unknown.code,说明服务端没注册会话能力(需重建插件并重启 dsh)。\n')
    process.exit(1)
  }
  const sessionId = created.data.sessionId
  check('创建会话', true, sessionId)
  // 发起连接已被服务端自动订阅 session:<id>,这里直接开始收事件即可
  const events = trackSessionEvents(socket, sessionId)

  // ── 2. 第一轮:建立上下文 ─────────────────────────────────────────────────
  console.log('\n[2] 第一轮:设定名字')
  const t1 = await request(socket, router, 'session.send', {
    sessionId,
    prompt: '记住:我的代号是「蓝鲸七号」。只回复"已记住"三个字。',
  }, TURN_TIMEOUT_MS)
  check('第一轮 status=done', t1.ok && t1.data?.status === 'done', t1.ok ? `${t1.data.durationMs}ms` : `${t1.code}: ${t1.message}`)
  info('第一轮回复', JSON.stringify(lastAssistantText(events) ?? '(无)'))

  // ── 3. 第二轮:验证上下文延续(核心) ──────────────────────────────────────
  console.log('\n[3] 第二轮:询问名字(验证上下文延续)')
  const before = events.length
  const t2 = await request(socket, router, 'session.send', {
    sessionId,
    prompt: '我的代号是什么?只回复代号本身。',
  }, TURN_TIMEOUT_MS)
  check('第二轮 status=done', t2.ok && t2.data?.status === 'done', t2.ok ? `${t2.data.durationMs}ms` : `${t2.code}: ${t2.message}`)
  const secondAnswer = lastAssistantText(events.slice(before))
  const remembered = typeof secondAnswer === 'string' && secondAnswer.includes('蓝鲸七号')
  info('第二轮回复', JSON.stringify(secondAnswer ?? '(无)'))
  check('agent 记住了上下文(回复含代号)', remembered, remembered ? '' : '上下文可能未延续')

  // ── 4. 空闲回收后 resume(核心风险点,可用 SMOKE_IDLE_WAIT_MS 启用) ────────
  const idleWaitMs = Number(process.env.SMOKE_IDLE_WAIT_MS ?? 0)
  if (idleWaitMs > 0) {
    console.log(`\n[4] 等待 ${idleWaitMs}ms 让常驻 agent 被空闲回收,再发一轮验证 resume`)
    console.log('    (需服务端 DSH_CONNECT_SESSION_IDLE_MS 小于该等待时长)')
    await new Promise((resolve) => setTimeout(resolve, idleWaitMs))
    const beforeResume = events.length
    const t3 = await request(socket, router, 'session.send', {
      sessionId,
      prompt: '再说一次我的代号。只回复代号本身。',
    }, TURN_TIMEOUT_MS)
    const resumedAnswer = lastAssistantText(events.slice(beforeResume))
    info('resume 后回复', JSON.stringify(resumedAnswer ?? '(无)'))
    const stillRemembered = typeof resumedAnswer === 'string' && resumedAnswer.includes('蓝鲸七号')
    check('resume 后上下文仍延续', t3.ok && stillRemembered, t3.ok ? (stillRemembered ? '' : '上下文丢失') : `${t3.code}: ${t3.message}`)
  } else {
    console.log('\n[4] (跳过 resume 验证;设 SMOKE_IDLE_WAIT_MS 并配短 idle 即可验证)')
  }

  // ── 5. 历史 ───────────────────────────────────────────────────────────────
  console.log('\n[5] session.history')
  const history = await request(socket, router, 'session.history', { sessionId })
  const messages = history.ok ? history.data.messages : []
  check('历史包含用户与助手消息', messages.length >= 4, `${messages.length} 条`)
  check('历史里能找到第一轮的提问', messages.some((m) => m.role === 'user' && m.text.includes('蓝鲸七号')))
  if (fail > 0 || process.env.SMOKE_VERBOSE === '1') {
    info('历史明细(注意宿主可能注入 <system-reminder> 之类的上下文消息):')
    for (const m of messages) console.log(`      [${m.role}] ${JSON.stringify(m.text.slice(0, 60))}`)
  }

  // ── 6. 列表 ───────────────────────────────────────────────────────────────
  console.log('\n[6] session.list / session.get')
  const listed = await request(socket, router, 'session.list', {})
  check('列表包含本会话', listed.ok && listed.data.sessions.some((s) => s.sessionId === sessionId))
  const got = await request(socket, router, 'session.get', { sessionId })
  check('get 返回摘要', got.ok && got.data.sessionId === sessionId, got.ok ? `title=${got.data.title}` : got.code)

  // ── 7. 软删 ───────────────────────────────────────────────────────────────
  console.log('\n[7] session.delete(软删)')
  const deleted = await request(socket, router, 'session.delete', { sessionId })
  check('delete 返回 deleted:true', deleted.ok && deleted.data.deleted === true)
  const afterDelete = await request(socket, router, 'session.list', {})
  check('删除后列表不含该会话', afterDelete.ok && !afterDelete.data.sessions.some((s) => s.sessionId === sessionId))
  const includeDeleted = await request(socket, router, 'session.list', { includeDeleted: true })
  check('includeDeleted 仍可查到(宿主文件保留)', includeDeleted.ok && includeDeleted.data.sessions.some((s) => s.sessionId === sessionId))

  socket.close()
  console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`\n脚本失败: ${error.message}`)
  console.error('排查:服务端是否启动?端口是否为日志里的 `ws server listening on` 值?\n')
  process.exit(1)
})

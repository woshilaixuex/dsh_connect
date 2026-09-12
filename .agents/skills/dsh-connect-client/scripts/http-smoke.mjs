/**
 * dsh-connect HTTP 只读接口冒烟(零依赖,用 Node 内置 fetch)。
 *
 * 用法:
 *   node scripts/http-smoke.mjs                          # 默认 http://127.0.0.1:8098
 *   node scripts/http-smoke.mjs http://192.168.1.10:8098
 *   DSH_CONNECT_HTTP_SMOKE_URL=http://host:port node scripts/http-smoke.mjs
 *
 * 退出码:0 = 全部通过;1 = 有失败项。
 */

const argUrl = process.argv.find((a) => a.startsWith('http://') || a.startsWith('https://'))
const BASE = (argUrl ?? process.env.DSH_CONNECT_HTTP_SMOKE_URL ?? 'http://127.0.0.1:8098').replace(/\/+$/, '')

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

async function req(path, init) {
  const res = await fetch(`${BASE}${path}`, init)
  const text = await res.text()
  let body
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    body = undefined
  }
  return { status: res.status, body, headers: res.headers, text }
}

async function main() {
  console.log(`\ndsh-connect HTTP 接口冒烟 — ${BASE}\n`)

  // 连通性
  try {
    await req('/health')
  } catch (error) {
    console.log(`  连接失败: ${error.message}`)
    console.log('\n排查:HTTP 端口是否为 8098(或 DSH_CONNECT_HTTP_PORT)?服务端日志有 `http server listening on` 吗?\n')
    process.exit(1)
  }

  console.log('[1] GET /health')
  const health = await req('/health')
  check('200 + ok:true', health.status === 200 && health.body?.ok === true)
  if (health.body?.ok) {
    info('概览', JSON.stringify(health.body.sessions) + ' workspaces=' + JSON.stringify(health.body.workspaces))
  }

  console.log('\n[2] GET /workspaces')
  const ws = await req('/workspaces')
  check('200 + ok:true', ws.status === 200 && ws.body?.ok === true)
  if (ws.body?.ok) {
    check('source 合法', ws.body.source === 'registry' || ws.body.source === 'cwd', `source=${ws.body.source}`)
    check('workspaces 是数组', Array.isArray(ws.body.workspaces))
    info('工作区数', String(ws.body.workspaces.length))
    for (const w of ws.body.workspaces.slice(0, 5)) {
      console.log(`      - ${w.title} (${w.path}) sessions=${w.sessionIds.length}`)
    }
  }

  console.log('\n[3] GET /sessions')
  const sessions = await req('/sessions?limit=10')
  check('200 + ok:true', sessions.status === 200 && sessions.body?.ok === true)
  let sampleId
  if (sessions.body?.ok) {
    const list = sessions.body.sessions
    check('sessions 是数组', Array.isArray(list))
    const bySource = list.reduce((acc, s) => ({ ...acc, [s.source]: (acc[s.source] ?? 0) + 1 }), {})
    info('来源分布', JSON.stringify(bySource))
    info('meta', JSON.stringify(sessions.body.meta))
    sampleId = list[0]?.sessionId
    for (const s of list.slice(0, 5)) {
      console.log(`      - ${s.sessionId} source=${s.source} live=${s.live} title=${JSON.stringify(s.title ?? null)}`)
    }
  }

  console.log('\n[4] GET /sessions/:id/history')
  if (sampleId) {
    const history = await req(`/sessions/${encodeURIComponent(sampleId)}/history?limit=5`)
    check('200 + ok:true', history.status === 200 && history.body?.ok === true)
    if (history.body?.ok) {
      check('sessionId 回显', history.body.sessionId === sampleId)
      check('messages 是数组', Array.isArray(history.body.messages))
      info('历史条数', `${history.body.messages.length}(source=${history.body.source})`)
    }
  } else {
    info('跳过', '没有会话可查')
  }

  console.log('\n[5] CORS / 预检')
  const healthHeaders = await req('/health')
  check('Allow-Origin: *', healthHeaders.headers.get('access-control-allow-origin') === '*')
  check('Cache-Control: no-store', healthHeaders.headers.get('cache-control') === 'no-store')
  const preflight = await req('/sessions', { method: 'OPTIONS' })
  check('OPTIONS → 204', preflight.status === 204, String(preflight.status))

  console.log('\n[6] 只读约束与错误')
  const post = await req('/sessions', { method: 'POST' })
  check('POST → 405', post.status === 405, String(post.status))
  const missing = await req('/nope')
  check('未知路径 → 404', missing.status === 404, String(missing.status))
  const badLimit = await req('/sessions?limit=-1')
  check('非法 limit → 400', badLimit.status === 400, String(badLimit.status))

  console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(`\n脚本失败: ${error.message}\n`)
  process.exit(1)
})

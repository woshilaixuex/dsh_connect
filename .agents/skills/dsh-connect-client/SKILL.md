---
name: dsh-connect-client
description: Implement, debug, or smoke-test a client for dsh-connect — the LAN agent proxy in a DeepSeek Harness (dsh) plugin. Read-only HTTP JSON API (GET /health, /workspaces, /sessions, /sessions/:id/history) fetches workspaces, session lists and message history; the v1 WebSocket protocol (req/res/evt/sub/ping/pong) carries writes — codes agent.run/agent.stop, session.create/list/get/history/send/stop/delete, workspace.list — with push topics task:<id> and session:<id>, session provenance (source client|host) over the host's existing sessions, and reasoning/progress events (assistant.reasoning, session.todo, tool.call.label). Includes Kotlin/OkHttp guidance. Use when wiring an app or Android client, fetching history over HTTP, adding multi-turn chat that reuses host sessions, showing the model's thinking or current task, porting the smoke scripts, or when a client cannot connect, sees no events, forgets prior turns, or returns host.unavailable / agent.failed / session.not.found / bad.frame.
compatibility: The bundled smoke scripts need Node 22+ (use the built-in global WebSocket; no npm install required).
argument-hint: "[ws://host:port]"
metadata:
  protocol-version: "1"
---

# dsh-connect 客户端实现与调试

dsh-connect 是跑在 dsh 宿主进程内的插件,在局域网上开一个 WebSocket,**客户端提交任务文本 → 宿主 agent 执行 → 执行事件流式回推**。
本 skill 覆盖:连通性验证、线协议、客户端实现、故障定位。

**两条主干,先选对**:

| 需求 | 用哪个 | 上下文 |
|---|---|---|
| 跑一次任务,不需要记得上文 | `agent.run`(WS) | 无状态,跑完即弃 |
| 聊天 / 多轮对话(要记得上文) | `session.create` + `session.send`(WS) | **有状态**,agent 被回收后自动 resume 恢复 |
| **只读:列工作区 / 列会话 / 读历史** | **HTTP GET**(见下) | 最省事,不用 WS 信封 |

## 只读取数据用 HTTP(不必走 WS)

HTTP 接口与 WS **分离端口**(默认 `8098`),只读、CORS 全开,浏览器 `fetch` / 安卓 OkHttp / curl 直接可用:

```bash
curl http://<host>:8098/health
curl http://<host>:8098/workspaces
curl "http://<host>:8098/sessions?limit=20"
curl "http://<host>:8098/sessions/<sessionId>/history?limit=50"
```

响应就是普通 JSON(`{ ok: true, ... }`);错误体 `{ ok:false, code, message, status }`。仅 `GET`/`HEAD`。
**写操作(发消息/建会话/删除)仍走 WS** —— HTTP 不提供。

字段级细节见 [references/protocol.md](references/protocol.md) 的「HTTP 只读接口」一节。

## 先做连通性验证(务必先跑通再写代码)

三个零依赖脚本(Node 22 全局 `WebSocket` / `fetch`),按需选:

```bash
# ① 协议 + 一次性任务(不消耗 token 的预检 + 真实跑一次 agent)
node smoke.mjs --no-agent ws://<host>:<port>   # 只验协议,不触发宿主推理
node smoke.mjs ws://<host>:<port>              # 完整端到端(会真的跑一次 agent)

# ② 会话能力(多轮上下文 + 历史 + 列表 + 软删)
node session-smoke.mjs ws://<host>:<port>

# 验证「空闲回收后 resume 仍记得上文」:服务端设短 DSH_CONNECT_SESSION_IDLE_MS,
# 再给脚本设更大的等待
SMOKE_IDLE_WAIT_MS=8000 node session-smoke.mjs ws://<host>:<port>

# ③ HTTP 只读接口(工作区 / 会话 / 历史)
node http-smoke.mjs http://<host>:<port>       # 默认 http://127.0.0.1:8098
```

也支持环境变量:`SMOKE_URL` / `SESSION_SMOKE_URL` / `DSH_CONNECT_HTTP_SMOKE_URL`。

**端口必须确认**:WS 默认 `8097`、HTTP 默认 `8098`,但都常被插件根 `.env` 覆盖(本机 WS 是 `8080`)。
以服务端日志 `ws server listening on <host>:<port>` / `http server listening on <host>:<port>` 为准。

脚本判定:

| 输出 | 含义 |
|---|---|
| `smoke.mjs --no-agent` 全绿 | 协议的 ping/sub/错误处理都对,服务端在正常监听 |
| `smoke.mjs` 全绿 | 宿主 agent 真正跑通了(会看到 `assistant.message`) |
| `session-smoke.mjs` 全绿 | 会话族可用,且**多轮上下文确实延续** |
| `http-smoke.mjs` 全绿 | HTTP 只读接口可用(工作区/会话/历史都能取) |
| `session-smoke.mjs` 第 1 步就 `unknown.code` | 服务端没注册会话能力(需重建插件并重启 dsh) |
| 「第二轮不记得代号」 | 上下文没延续:查服务端 resume 日志 / 是否误用 `agent.run` |
| `agent.run` 返回 `host.unavailable` | 服务端在,但宿主没挂 agent 服务(服务端问题,不是客户端问题) |
| `status: failed` + `error` | 宿主侧执行失败(常见:没配模型路由) |
| HTTP 连接被拒 | HTTP 端口不对或已禁用(`DSH_CONNECT_HTTP_PORT`);看日志 `http server listening on` |

## 实现客户端

1. **读协议规格**:[references/protocol.md](references/protocol.md) —— 逐字段的权威表(帧信封、接收码含会话族、推送码、错误码、时序)。实现时以它为准。
2. **Android/Kotlin**:[references/kotlin-client.md](references/kotlin-client.md) —— OkHttp + kotlinx.serialization 的可用骨架,含会话封装、Android 特有的明文流量/权限坑。
3. **其它平台**:按 protocol.md 自行实现,核心只有三件事 —— `res` 按 `id` 派发、`evt` 按 `push` + `data.kind` 分流、多轮对话复用同一个 `sessionId`。
4. **照抄现成实现**:`scripts/smoke.mjs`(一次性任务)与 `scripts/session-smoke.mjs`(会话多轮)是两个可直接运行的参考客户端。

## 必须遵守的协议语义

违反这些是客户端最常见的 bug 来源:

1. **`res` 靠 `id` 关联,可乱序返回**。并发请求要维护 `id → 等待者` 的映射,不能假设先发先回。
2. **`evt` 只发给已订阅该推送码的连接**。自动订阅有三处:`agent.run` 把**发起连接**加入 `task:<taskId>`;`session.create` **和 `session.send`** 把**发起连接**加入 `session:<sessionId>`。其它连接(观察别人的任务/会话)必须显式 `sub`。
   - `session.send` 的自动订阅很关键:**重启服务端后客户端重连、继续用旧会话时走的是 `send` 而不是 `create`**,漏订阅会让 agent 照常执行、客户端却收不到任何事件而永远停在「运行中」。
3. **要「记得上文」必须用会话族,不能靠 `agent.run`**。`agent.run` 每次都是全新会话、跑完即弃;会话的上下文由服务端 `resume` 保证,客户端只需复用同一个 `sessionId`。
4. **未知 `data.kind` 一律忽略**,不要报错 —— 协议要求前向兼容,服务端会新增事件类型。
5. **帧级 `err`(`bad.frame`/`bad.size`)不关闭连接**。只提示/记录,不要据此断开。
6. **单帧 ≤ 256 KB**,`id`/`code`/推送码 ≤ 128 字符且非空。
7. **任务可能以失败告终**:最终 res 的 `status` 是 `done`/`stopped`/`failed`,失败时看 `error` 字段;不要只在等到 `assistant.message` 时才处理结束。
8. **长任务要放宽超时**:`agent.run` / `session.send` 可能跑几分钟,别用 30s 的通用请求超时。
9. **会话历史可能含宿主注入的上下文消息**(如 `<system-reminder>`、运行时上下文),客户端按需过滤。

## 接收码 / 推送码速查

**一次性任务(无状态)**

- `agent.run` — payload `{prompt, cwd?, chunks?}` → res.data `{taskId, sessionId, status, durationMs, error?}`
- `agent.stop` — payload `{taskId}` → res.data `{taskId, status}`;仅发起连接可停

**会话(多轮,有状态)**

- `session.create` — `{sessionId?, title?, cwd?}` → `{sessionId, source, reused, title?}`(**自动订阅** `session:<id>`;传已有 id 即复用)
- `session.list` — `{limit?, offset?, includeDeleted?}` → `{sessions: [SessionSummary]}`(**宿主会话 ∪ 本插件会话**)
- `session.get` — `{sessionId}` → `SessionSummary`
- `session.history` — `{sessionId, limit?}` → `{messages: [{role, text, ts}]}`
- `session.send` — `{sessionId, prompt, chunks?}` → `{sessionId, status, durationMs, error?}`(**自动订阅** `session:<id>`)
- `session.stop` — `{sessionId}` → `{sessionId, status}`(只打断当前轮,保留会话)
- `session.delete` — `{sessionId}` → `{sessionId, deleted: true}`(**软删**,宿主文件仍在)
- `workspace.list` — `{includeDeleted?}` → `{source: 'registry'|'cwd', workspaces: [{workspaceId, path, title, sessionIds}]}`
- `approval.respond` — `{sessionId, pendingId, allow: boolean}` → `{pendingId, outcome}`(回复**权限请求**;`allow=true`=本次授予,`false`=拒绝;先到先得)

`SessionSummary` = `{sessionId, source: 'client'|'host', title?, cwd?, createdAt, updatedAt, live, persisted, messageCount?, lastMessage?, deleted?}`
`source='host'` = 宿主已有的(web UI 建的也能看到);`source='client'` = 本插件为客户端建的(`client-` 前缀)。

**推送码**

- `task:<taskId>` — 一次性任务事件流
- `session:<sessionId>` — 会话事件流(额外有 `session.user-message`,即用户输入回显)
- 两者 `evt.data.kind`:
  - 执行结构:`agent.status` / `session.turn` / `session.todo` / `session.plan`
  - 思考:`assistant.reasoning`(完整,默认推)/ `assistant.reasoning-chunk`(流式,仅 `chunks:true`)
  - 回复:`assistant.message` / `assistant.chunk`(仅 `chunks:true`)
  - 工具:`tool.call`(带 `label` 人类可读标题)/ `tool.result`
  - 权限请求:`session.approval`(带 `pendingId`/`toolName`/`callId?`/`reason?`,回 `approval.respond` 处理)
  - 失败:`agent.error`

完整字段与错误码见 [references/protocol.md](references/protocol.md)。

## 故障对照表

| 现象 | 多半原因 | 处理 |
|---|---|---|
| 连接被拒 / refused | 服务端没起,或 host:port 错 | 看服务端日志的 `ws server listening on`;确认不是默认 8097 被 `.env` 覆盖 |
| 连上立刻断(Android,code 1006) | 明文流量被系统拦截 | 见 kotlin-client.md §0:`usesCleartextTraffic` / networkSecurityConfig |
| 连上立刻断(Android) | 缺 `INTERNET` 权限 | 加 `<uses-permission android:name="android.permission.INTERNET"/>` |
| `err` `bad.frame` | JSON 非法,或 `v` 不是 1 | 用 JSON 序列化库,别手拼字符串 |
| `err` `bad.size` | 帧 > 256 KB | 大 prompt 分段,或让服务端支持附件 |
| `res` `unknown.code` | 接收码拼错 / 服务端没注册 | 对照上方接收码表 |
| `res` `bad.request` | payload 缺必填字段 | `agent.run` 必须有非空 `prompt` |
| `res` `host.unavailable` | 宿主没挂 agent 服务 | **服务端问题**,检查 dsh 是否正常启动 |
| `res` `agent.failed` | 拉起 agent 或投递失败 | 看服务端日志;常见是模型路由未配置 |
| 完全收不到 `evt` | 没订阅该推送码 | 自己发起任务/会话会自动订阅;观察别人的需先 `sub` |
| 重启服务端后继续用旧会话,UI 一直「运行中」 | 该连接没订阅 `session:<id>`(历史缺陷:`session.send` 曾不自动订阅) | 服务端已修(send 也自动订阅);确认客户端用的是当前版本服务端 |
| 工具类任务「没反应」但 agent 其实干完了 | 沙箱 `workspace-write` + 审批通道缺失,需要升级权限的命令被拒 | agent 会在回复里说明;要放开由服务端设 `DSH_PERMISSION_MODE=danger-full-access` |
| `session.send` 返回 `session.not.found` | 会话 id 不存在或已被软删 | 用 `session.list` 确认;软删的可用 `includeDeleted:true` 查到 |
| `session.resume-failed` | 会话在索引里但宿主侧拿不到(从未落盘/已删) | 检查服务端日志的 resume 记录;必要时重建会话 |
| 多轮对话「不记得上文」 | 用的是 `agent.run`(无状态) | 改用 `session.create` + `session.send` |
| `session.history` 消息不全 | 活跃会话的最新消息尚未落盘 | 服务端优先用内存历史;重启后会从宿主 jsonl 补 |
| 看不到宿主已有的会话 | 只在看本插件索引 | `session.list` 已返回宿主 ∪ 本插件;确认服务端日志的 `session mirror: host=N` |
| `workspace.list` 返回 `source:'cwd'` | 宿主没挂 `workspaceRegistry`(它只在 web-app bundle) | 属预期降级;要完整工作区需在 profile 加装 `@deepseek-ai/dsh-workspace` |
| 会话不出现在任何 workspace | 建会话时没传 `cwd`(或 cwd 与 workspace path 不等) | `session.create` 时传 `cwd`;host workspace 要求 cwd 与 path realpath 相等 |
| 收不到 `assistant.reasoning` | 该模型这轮没产生思考,或思考在 `assistant.message` 里 | reasoning 是模型行为,不保证每轮都有;`chunks:true` 时另有 `assistant.reasoning-chunk` |
| `tool.call` 没有 `label` | 宿主该工具没定义 `presentCall` | 属正常降级;客户端退回显示 `name` |
| 收到 `agent.error` 且 `status:"failed"` | 宿主执行期报错 | 常见:宿主 root agent 缺 provider/model(服务端配置 `DSH_CONNECT_AGENT_PROVIDER`/`_MODEL`) |
| 并发请求结果错配 | 按到达顺序匹配了 res | 改成按 `id` 派发 |

**HTTP 接口(取数据路径)**

| 现象 | 多半原因 | 处理 |
|---|---|---|
| HTTP 连接被拒 | 端口不对,或已禁用 | 默认 `8098`;`DSH_CONNECT_HTTP_PORT=-1` 会禁用;看日志 `http server listening on` |
| HTTP `404` | 路由拼错 | 只有 `/health` `/workspaces` `/sessions` `/sessions/:id/history` |
| HTTP `405` | 用了 POST/PUT/DELETE | **HTTP 只读**;写操作(发消息/建会话/删除)走 WS |
| HTTP `400` | `limit` 不是非负整数 | 检查查询参数 |
| HTTP 返回空 `sessions` | 会话确实被软删了 | 加 `?includeDeleted=1` 复查 |
| `history` 的 `source` 是 `persisted` 但消息少 | 活跃会话的最新消息尚未落盘 | 属正常:活跃会话走内存(`source:"memory"`),未激活才读宿主 jsonl |
| CORS 报错(浏览器) | 极少见,接口已全开 | 确认请求打到 HTTP 端口而不是 WS 端口 |

## 服务端源码(排查服务端侧问题时)

如果 dsh-connect 源码可用,线协议的权威实现是:

- `src/protocol/frame.ts` —— 帧构造/解析、错误码常量、256KB 上限、推送码前缀(`PushPrefix`/`sessionTopic`/`taskTopic`)
- `src/tasks/agent-task.ts` —— `agent.run` / `agent.stop` 的行为与 res 结构
- `src/tasks/session-task.ts` —— `session.*` 的行为、参数校验与错误码映射
- `src/sessions/session-registry.ts` —— 会话常驻/空闲回收/resume 回退/串行队列(理解客户端时序的关键)
- `src/sessions/session-index.ts` —— 会话索引表结构
- `src/sessions/persisted-history.ts` —— `session.history` 的持久化读取
- `src/bridge/event-map.ts` —— 宿主事件 → `evt.data` 载荷的映射
- `src/server/server.ts` —— 连接生命周期、帧分派
- `README.md` 的「WS 协议(v1)」小节 —— 面向人类的协议说明

服务端排查要点(客户端报「事件收不到 / 上下文丢失」时):

- `evt` 只发订阅者 —— 先确认订阅。
- 会话上下文由服务端 `agents.resume` 保证 —— 看日志里的 `session resumed:` / `session created (after resume failure):`。
- 空闲回收阈值由 `DSH_CONNECT_SESSION_IDLE_MS` 控制(默认 10 分钟)。

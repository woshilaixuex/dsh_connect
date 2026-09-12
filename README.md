# dsh-connect

A dsh plugin scaffolded by [dsh-dev](https://github.com/dsh-io/dsh-dev).

## Develop

```bash
npx @dsh-io/dsh-dev dev
```

## Install

```bash
dsh plugin --profile demo add .
```

## HTTP 只读接口

与 WS **分离端口**(默认 `8098`,`DSH_CONNECT_HTTP_PORT` 覆盖;`-1` 禁用),提供最普通的 **GET JSON** 入口 —— 浏览器 `fetch`、安卓 OkHttp、`curl` 都能直接用,不必走 WS 信封协议。

**只读**:写操作(发消息/建会话/删除)仍然走 WS。CORS 全开(`Access-Control-Allow-Origin: *`),无鉴权(同 WS 的局域网信任模型)。

| 路由 | 查询参数 | 响应 |
|---|---|---|
| `GET /health` | — | `{ ok, uptimeMs, sessions: { host, index, live }, workspaces: { source, count } }` |
| `GET /workspaces` | `includeDeleted?` | `{ ok, source: 'registry'\|'cwd', workspaces: [{ workspaceId, path, title, sessionIds }] }` |
| `GET /sessions` | `limit?`(默认 50,上限 1000)`offset?`(0)`includeDeleted?` | `{ ok, sessions: [SessionSummary], meta }` |
| `GET /sessions/:sessionId/history` | `limit?`(默认 100) | `{ ok, sessionId, source: 'memory'\|'persisted', messages: [{ role, text, ts }] }` |

```bash
curl http://127.0.0.1:8098/health
curl http://127.0.0.1:8098/workspaces
curl "http://127.0.0.1:8098/sessions?limit=10"
curl "http://127.0.0.1:8098/sessions/<sessionId>/history?limit=20"
```

约定:

- 方法是 `GET`/`HEAD`;`OPTIONS` 回 `204` 预检;其它方法 `405`。
- 所有响应 `Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store`。
- 错误体统一 `{ ok:false, code, message, status }`;`400` 参数非法、`404` 未知路由、`405` 方法不允许、`500` 内部错误。
- **无缓存**:每次请求实时读宿主(会话极多时会慢),本版不做缓存。
- HTTP 与 WS **互相隔离**:任一端口起不来不影响另一个。

## WS 协议(v1)

dsh-connect 在 `hostName:listenPort`(默认 `0.0.0.0:8097`)提供局域网 WebSocket 服务。
帧一律 **JSON 文本**,单帧上限 **256 KB**;二进制/无法解析的帧回帧级 `err`(不断开连接)。
**无鉴权**(局域网信任模型),连接断开自动清理其订阅与运行中的任务。

### 帧格式

客户端 → 服务端:

| kind | 字段 | 说明 |
|---|---|---|
| `req` | `id`, `code`, `payload?` | **接收请求**:按接收码匹配处理器,回 `res` |
| `sub` | `id?`, `add?`, `remove?` | 管理本连接的推送码订阅(带 id 则回 `res ok`) |
| `ping` | — | 保活,服务端回 `pong` |

服务端 → 客户端:

| kind | 字段 | 说明 |
|---|---|---|
| `res` | `id`, `ok`, `data?` / `code`,`message` | 请求结果;失败 `ok:false` + 稳定错误码 |
| `evt` | `push`, `data?`, `ts` | **推送事件**:发给所有已订阅该推送码的连接 |
| `err` | `code`, `message` | 帧级错误(无 id 可关联时) |
| `pong` | — | ping 的应答 |

示例:

```jsonc
// 提交一个 agent 任务(接收码 agent.run)
{"v":1,"kind":"req","id":"r-1","code":"agent.run","payload":{"prompt":"读取项目 README 并总结","chunks":false}}
// 执行期间收到的事件流(推送码 task:<taskId>)
{"v":1,"kind":"evt","push":"task:remote-xxx","data":{"kind":"agent.status","status":"running"},"ts":1780000000000}
{"v":1,"kind":"evt","push":"task:remote-xxx","data":{"kind":"tool.call","callId":"c1","name":"read_file","arguments":"{\"path\":\"README.md\"}"},"ts":1780000000000}
{"v":1,"kind":"evt","push":"task:remote-xxx","data":{"kind":"assistant.message","text":"README 说……"},"ts":1780000000000}
// 任务结束
{"v":1,"kind":"res","id":"r-1","ok":true,"data":{"taskId":"remote-xxx","sessionId":"remote-xxx","status":"done","durationMs":4200}}
```

### 接收码(上行请求)

**会话(多轮对话,推荐)**

| code | payload | res data | 说明 |
|---|---|---|---|
| `session.create` | `{ sessionId?, title?, cwd? }` | `{ sessionId, source, reused, title? }` | 新建**或复用**会话。传已有 `sessionId` → 复用(resume,上下文延续);不传 → 生成 `client-<uuid>`。**发起连接自动订阅** `session:<sessionId>` |
| `session.list` | `{ limit?, offset?, includeDeleted? }` | `{ sessions: [SessionSummary] }` | **宿主已有会话 ∪ 本插件会话**(含来源标记;默认不含软删) |
| `session.get` | `{ sessionId }` | `SessionSummary` | 单个会话详情(宿主会话也可查) |
| `session.history` | `{ sessionId, limit? }` | `{ messages: [{ role, text, ts }] }` | 消息历史(含 `user`/`assistant` 文本) |
| `session.send` | `{ sessionId, prompt, chunks? }` | `{ sessionId, status, durationMs, error? }` | 在会话里发一条消息(agent 记得上下文);同会话消息串行执行。**发起连接自动订阅** `session:<sessionId>` |
| `session.stop` | `{ sessionId }` | `{ sessionId, status }` | 打断当前轮,**保留会话** |
| `session.delete` | `{ sessionId }` | `{ sessionId, deleted: true }` | **软删**(宿主无删除 API,仅从本插件列表隐藏) |
| `workspace.list` | `{ includeDeleted? }` | `{ source, workspaces: [{ workspaceId, path, title, sessionIds }] }` | 工作区列表;`source` 为 `registry`(复用宿主 `ctx.workspaceRegistry`)或 `cwd`(兜底按会话 cwd 分组) |
| `approval.respond` | `{ sessionId, pendingId, allow: boolean }` | `{ pendingId, outcome }` | 回复一个待决的**权限请求**;`allow=true` → `allowed-once`(本次授予),`false` → `rejected`。会话订阅者先到先得 |

`SessionSummary` = `{ sessionId, source: 'client'|'host', title?, cwd?, createdAt, updatedAt, live, persisted, messageCount?, lastMessage?, deleted? }`

**会话来源**:`source: 'client'` = 本插件为客户端创建(前缀 `client-`);`source: 'host'` = 宿主已有(web UI 或其它入口建的)。
宿主侧没有可用的来源字段,该标记由本插件索引维护。

**注意**:`session.create` 与 `session.send` 都会把**发起连接**自动加入 `session:<sessionId>`。
重启 dsh 后客户端重连、继续用旧会话时走的是 `send`,自动订阅保证你仍能收到事件流。

会话的「真相」是宿主 session(jsonl 持久化 + `agents.resume`):agent 空闲回收后再发消息会自动 `resume`,**上下文延续**。
索引(来源/标题/时间/预览/软删标记)存在本插件 SQLite。传 `cwd` 可让会话归属到对应工作区(不传则落宿主 `_no-cwd` 桶)。

**一次性任务(无状态)**

| code | payload | res data | 说明 |
|---|---|---|---|
| `agent.run` | `{ prompt: string, cwd?, chunks? }` | `{ taskId, sessionId, status, durationMs, error? }` | 把任务文本投给宿主 dsh agent 执行;**发起连接自动订阅** `task:<taskId>`。`status` 为 `done`/`stopped`/`failed`。**无上下文延续**,需要多轮请用会话族 |
| `agent.stop` | `{ taskId: string }` | `{ taskId, status }` | 停止任务(仅发起连接可停);连接断开也会自动停止其任务 |

模型路由:默认用宿主默认模型(`ctx.agentDefaultModel`);要指定则设 `DSH_CONNECT_AGENT_PROVIDER` + `DSH_CONNECT_AGENT_MODEL`(必须成对)。
会话空闲回收阈值:默认 10 分钟,`DSH_CONNECT_SESSION_IDLE_MS` 覆盖(毫秒)。

### 推送码(下行事件)

客户端先 `sub` 订阅,服务端才推 `evt`。两个**动态主题**:

- `task:<taskId>` —— 一次性任务事件流(`agent.run` 发起连接自动订阅)。
- `session:<sessionId>` —— 会话事件流(`session.create` / `session.send` 发起连接自动订阅;要观察别人的会话需显式 `sub`)。

事件载荷(`evt.data.kind`):

| kind | 载荷摘要 | 来源 |
|---|---|---|
| `agent.status` | `{ status: 'running'\|'idle' }` | 宿主 `agent/status` |
| `session.user-message` | `{ text }`(会话内用户输入回显,便于多端同步) | 本插件 |
| `session.turn` | `{ turn, phase: 'start'\|'end', reason? }` | 宿主 `turn/start`、`turn/end` |
| `session.todo` | `{ todos: [{ content, status }] }`(模型的待办清单,整体替换) | 宿主 `todo/write` |
| `session.plan` | `{ active, pending? }`(计划模式状态) | 宿主 `plan/mode` + 投影 |
| `assistant.reasoning` | `{ text, turn?, step? }`(**完整思考过程**,默认推送) | `assistant/message` 的 reasoning 块 |
| `assistant.message` | `{ text?, toolCalls?: [{id,name,arguments}], turn?, step? }` | `assistant/message` |
| `assistant.chunk` | `{ chunk, ... }`(仅 `chunks:true`) | `assistant/chunk` |
| `assistant.reasoning-chunk` | `{ index?, text?, turn?, step? }`(**思考流式增量**,仅 `chunks:true`) | `assistant/chunk` 的 `reasoning-delta` |
| `tool.call` | `{ callId, name, arguments, label? }`(`label` 是宿主工具的人类可读标题) | `tool/call` + `presentCall` |
| `tool.result` | `{ callId, ok, text?, error?, turn?, step? }` | `tool/result` |
| `session.approval` | `{ pendingId, toolName, callId?, reason? }`(待回复的权限请求) | 宿主 `approval/request` |
| `agent.error` | `{ message }` | 宿主 `agent/error` |

顺序保证:同一轮里 `assistant.reasoning` 先于 `assistant.message` 推送,客户端可直接按到达顺序渲染「思考区 → 正文」。

### 权限请求(审批桥接)

当宿主 agent 遇到需要批准的操作(sandbox 升级、`ask` 策略的工具调用)时,插件会把请求转给远程客户端:

1. 服务端推 `session.approval`(带 `pendingId` / `toolName` / 可选 `callId` / `reason`)到 `session:<sessionId>`。
2. 客户端 UI 展示后,回 `approval.respond { sessionId, pendingId, allow }`。
3. `allow=true` → 本次授予(`allowed-once`);`false` → 拒绝(`rejected`)。

边界:

- **先到先得**:同一会话多订阅者时,第一个合法回复生效;其余得到 `approval.not.found`。
- **超时兜底**:客户端不回复 → 超时自动拒绝(默认 120s,`DSH_CONNECT_APPROVAL_TIMEOUT_MS` 覆盖)。所以客户端没实现审批也不会把 agent 卡死。
- **逐次询问**:宿主只支持 `allowed-once`(本次一次性授予),没有「始终允许」;每次审批都要回复一次。
- **web UI 共存**:本插件只认领「自己管理的会话」的审批;web UI 的会话审批不受影响。

### 错误码

帧级:`bad.frame`、`bad.size`。请求级(`res ok:false`):`unknown.code`、`bad.request`、
`internal`、`host.unavailable`、`agent.failed`、`agent.not.found`、`forbidden`、
`session.not.found`、`session.busy`、`session.resume-failed`、`approval.not.found`。

### 扩展

新增任务类型 = 在插件内 `hub.registerReceiver(code, handler)` 注册一个处理器
(handler 可经 `ctx` 调 `subscribe/publish` 产出自己的推送主题);代码见 `src/tasks/agent-task.ts`
与 `src/tasks/session-task.ts`。

### 宿主依赖(可选)

`workspace.list` 优先复用宿主的 `ctx.workspaceRegistry`,而它**不在 base bundle**里(只在 web-app)。
要在本 profile 启用,把 `@deepseek-ai/dsh-workspace` 加进 profile 依赖并在 `cordis.patch.yml` 里 insert 一行;
**未安装时自动回退**为按会话 `cwd` 分组(`source: 'cwd'`),不影响其它能力。
# dsh_connect

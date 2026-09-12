# dsh-connect 线协议 v1(逐字段)

服务端是 dsh 宿主里的插件(`dsh-dsh-connect`),开**两个**监听:

| 通道 | 默认端口 | 用途 |
|---|---|---|
| **HTTP(只读)** | **8098** | 取数据最省事:`GET /health` `/workspaces` `/sessions` `/sessions/:id/history` |
| WebSocket(读 + 写) | 8097 | 发消息、建会话、删除;实时事件流 |

两者都可能被 `.env` 覆盖(本机 WS 实际是 `8080`)。以服务端日志为准:
`http server listening on <host>:<port>` / `ws server listening on <host>:<port>`。

---

## 0. HTTP 只读接口(取数据首选)

独立端口,只读,`GET`/`HEAD`,CORS 全开(`Access-Control-Allow-Origin: *`),无鉴权。
**写操作不在这里** —— 发消息/建会话/删除仍走 WS。

| 路由 | 查询参数 | 响应 |
|---|---|---|
| `GET /health` | — | `{ ok, uptimeMs, sessions: { host, index, live }, workspaces: { source, count } }` |
| `GET /workspaces` | `includeDeleted?` | `{ ok, source: 'registry'\|'cwd', workspaces: [{ workspaceId, path, title, sessionIds }] }` |
| `GET /sessions` | `limit?`(默认 50,上限 1000)`offset?`(默认 0)`includeDeleted?` | `{ ok, sessions: [SessionSummary], meta }` |
| `GET /sessions/:sessionId/history` | `limit?`(默认 100) | `{ ok, sessionId, source: 'memory'\|'persisted', messages: [{ role, text, ts }] }` |

`SessionSummary` 与 WS 的同名结构一致(见 §3)。
`includeDeleted` 接受 `1`/`true` 为真。

约定:

- 方法:`GET`/`HEAD` 放行;`OPTIONS` → `204`(预检);其它 → `405`。
- 响应头:`Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store`。
- 错误体:`{ ok:false, code, message, status }`;`400` 参数非法、`404` 未知路由、`405` 方法不允许、`500` 内部错误。
- 尾斜杠容忍(`/sessions/` 等价 `/sessions`)。
- **无缓存**:服务端每次实时读宿主;会话多时较慢。实时事件没有 HTTP 版本,仍走 WS。

```jsonc
// GET /sessions?limit=2
{"ok":true,"sessions":[{"sessionId":"client-x","source":"client","title":"…","cwd":"D:/p","createdAt":1,"updatedAt":2,"live":true,"persisted":true,"messageCount":4,"lastMessage":"…"}],"meta":{"limit":2,"offset":0,"includeDeleted":false,"hostCount":27,"indexCount":17,"returned":2}}

// GET /sessions/client-x/history?limit=2
{"ok":true,"sessionId":"client-x","source":"persisted","messages":[{"role":"user","text":"…","ts":1},{"role":"assistant","text":"…","ts":2}]}
```

---

## 1. 帧信封(WebSocket)

服务端在 `hostName:listenPort` 上提供 WebSocket。
默认端口 **8097**;具体部署可能被 `.env` 覆盖(例如 `8080`),以服务端日志 `ws server listening on <host>:<port>` 为准。

- 传输:WebSocket,帧一律 **UTF-8 JSON 文本**;二进制帧不受支持(回帧级 `err`)
- 单帧上限 **256 KB**(`MAX_FRAME_BYTES`),超出回 `bad.size`
- 协议版本字段 `v` 恒为 `1`;`v` 不为 1 → 帧级 `bad.frame`
- **无鉴权**(局域网信任模型)
- `id` / `code` / 推送码:非空字符串,长度 ≤ 128

每帧是 JSON 对象,必含 `v` 与 `kind`。

### 客户端 → 服务端

| kind | 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|---|
| `req` | `id` | string | ✓ | 请求 id,客户端生成(UUID),用于关联 `res` |
| | `code` | string | ✓ | **接收码**,决定服务端路由到哪个处理器 |
| | `payload` | object | ✗ | 请求参数,结构由接收码决定 |
| `sub` | `id` | string | ✗ | 带上则服务端回一条 `res ok`(同 id) |
| | `add` | string[] | ✗ | 要订阅的推送码 |
| | `remove` | string[] | ✗ | 要退订的推送码;可与 `add` 同时给 |
| `ping` | — | | | 保活;服务端必回 `pong` |

### 服务端 → 客户端

| kind | 字段 | 类型 | 说明 |
|---|---|---|---|
| `res` | `id` | string | 对应请求 id |
| | `ok` | boolean | 成功与否 |
| | `data` | object | `ok:true` 时可选;成功摘要 |
| | `code` | string | `ok:false` 时:稳定错误码 |
| | `message` | string | `ok:false` 时:人读描述 |
| `evt` | `push` | string | **推送码**,说明事件来源(如 `task:<taskId>`) |
| | `data` | object | 事件载荷,必含 `kind` 字段 |
| | `ts` | number | 毫秒时间戳(epoch) |
| `err` | `code` | string | 帧级错误码 |
| | `message` | string | 描述 |
| `pong` | — | | `ping` 的应答 |

关键语义:

- `res` 与 `req` 通过 `id` 关联,**可乱序返回**;同一连接可并发多个 `req`。
- 帧级 `err` **不关闭连接**;收到后提示/忽略即可,不要据此断开。
- `evt` **只发给已订阅该推送码的连接**(规则统一,无例外)。

---

## 2. 订阅规则

- 用 `sub.add` 订阅推送码;`sub.remove` 退订。同一推送码可多连接订阅(广播)。
- **自动订阅**:`agent.run` 把发起连接加入 `task:<taskId>`;`session.create` 把发起连接加入 `session:<sessionId>`。自己发起的任务/会话无需手动订阅。
- 其它连接想观察某任务/会话,需先拿到 id 再 `sub add:["task:<id>"]` / `["session:<id>"]`。
- 一次性任务收尾(收到 `res`)后服务端自动退订其主题;连接断开时清空该连接全部订阅。会话主题在连接存续期间保持订阅。

---

## 3. 接收码(上行请求)

### `agent.run` — 把任务投给宿主 dsh agent 执行

payload:

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `prompt` | string | ✓ | 任务文本(非空) |
| `cwd` | string | ✗ | 工作目录 |
| `chunks` | boolean | ✗ | 默认 `false`;`true` 时额外推送 token 级 `assistant.chunk` |

成功 `res.data`:

| 字段 | 类型 | 说明 |
|---|---|---|
| `taskId` | string | 本任务 id;事件主题为 `task:<taskId>` |
| `sessionId` | string | 当前实现与 `taskId` 相同 |
| `status` | `"done"` \| `"stopped"` \| `"failed"` | `failed` 表示宿主执行期报错 |
| `durationMs` | number | 耗时 |
| `error` | string | 仅 `status:"failed"` 时存在 |

错误码:

| code | 触发 |
|---|---|
| `bad.request` | `payload.prompt` 缺失/非法 |
| `host.unavailable` | 宿主没有 agent 服务(agents/agentLoop 都探测不到) |
| `agent.failed` | 拉起 agent 或投递消息失败 |
| `unknown.code` | 服务端未注册该接收码 |

### `agent.stop` — 停止任务

payload:`{ "taskId": string }`

成功 `res.data`:`{ "taskId": string, "status": "stopped" }`

错误码:

| code | 触发 |
|---|---|
| `bad.request` | `taskId` 缺失/非法 |
| `agent.not.found` | 任务不存在或已结束 |
| `forbidden` | 非发起该任务的连接 |

### 会话族 `session.*` — 多轮对话(需要「记得上文」时用这个)

`agent.run` 是**无状态**的一次性任务;要上下文延续必须用会话族——会话真相是宿主 session(JSONL 持久化),agent 空闲回收后会自动 `resume` 恢复上下文。

| code | payload | 成功 res.data |
|---|---|---|
| `session.create` | `{ sessionId?, title?, cwd? }` | `{ sessionId, source, reused, title? }` |
| `session.list` | `{ limit?, offset?, includeDeleted? }` | `{ sessions: [SessionSummary] }` |
| `session.get` | `{ sessionId }` | `SessionSummary` |
| `session.history` | `{ sessionId, limit? }` | `{ messages: [{ role, text, ts }] }` |
| `session.send` | `{ sessionId, prompt, chunks? }` | `{ sessionId, status, durationMs, error? }` |
| `session.stop` | `{ sessionId }` | `{ sessionId, status: 'stopped' }` |
| `session.delete` | `{ sessionId }` | `{ sessionId, deleted: true }` |
| `workspace.list` | `{ includeDeleted? }` | `{ source: 'registry'\|'cwd', workspaces: [{ workspaceId, path, title, sessionIds }] }` |
| `approval.respond` | `{ sessionId, pendingId, allow: boolean }` | `{ pendingId, outcome: 'allowed-once'\|'rejected' }` |

`SessionSummary` = `{ sessionId, source: 'client'|'host', title?, cwd?, createdAt, updatedAt, live, persisted, messageCount?, lastMessage?, deleted? }`

错误码:`session.not.found`、`session.resume-failed`、`approval.not.found`、`bad.request`。

**新建 / 复用**(`session.create`):

| 传入 | 行为 | `source` |
|---|---|---|
| `sessionId`(宿主已有) | **复用**该会话(resume,上下文延续) | `'host'` |
| `sessionId`(宿主没有) | 用该 id 新建 | `'client'` |
| 不传 | 服务端生成 `client-<uuid>` | `'client'` |

`reused: true` 表示复用了已有会话。

**镜像宿主会话**:`session.list` 返回的是**宿主已有会话 ∪ 本插件会话**,所以能看到用户在 web UI 里建的会话(`source: 'host'`),标题来自宿主。
宿主侧没有来源字段,`source` 由本插件索引维护。

关键语义:

- **`session.create` 与 `session.send` 都把发起连接自动订阅** `session:<sessionId>`;观察**别人创建**的会话需自己 `sub`。
- 同一会话的消息**串行执行**;不同会话并行。
- `session.stop` 只打断当前轮,**保留会话**;`session.delete` 是**软删**(宿主无删除 API,只从列表隐藏)。
- 传 `cwd` 建会话才会归属到工作区(不传则落宿主 `_no-cwd` 桶,不出现在任何 workspace 里)。
- 历史里可能含宿主注入的上下文(`<system-reminder>` 等),客户端可按需过滤。

```jsonc
// 复用宿主已有会话
{"v":1,"kind":"req","id":"c1","code":"session.create","payload":{"sessionId":"session-42"}}
// 新建客户端会话(带 cwd 以便归属工作区)
{"v":1,"kind":"req","id":"c2","code":"session.create","payload":{"title":"我的会话","cwd":"D:/proj"}}
{"v":1,"kind":"req","id":"s1","code":"session.send","payload":{"sessionId":"client-xxx","prompt":"记住:我叫蓝鲸"}}
{"v":1,"kind":"req","id":"s2","code":"session.send","payload":{"sessionId":"client-xxx","prompt":"我叫什么?"}}   // agent 记得
{"v":1,"kind":"req","id":"w1","code":"workspace.list","payload":{}}
```

---

## 4. 推送码(下行事件)

### `task:<taskId>`

`evt.data` 按 `kind` 区分:

| kind | 字段 | 说明 |
|---|---|---|
| `agent.status` | `status`:`"running"` \| `"idle"` | agent 生命周期 |
| `session.turn` | `turn`,`phase`:`"start"`\|`"end"`,`reason?` | 轮次边界,可渲染阶段 |
| `session.todo` | `todos:[{content,status}]` | 模型的待办清单(整体替换);`status` ∈ `pending`/`in_progress`/`completed` |
| `session.plan` | `active`,`pending?` | 计划模式状态 |
| `assistant.reasoning` | `text`,`turn?`,`step?` | **完整思考过程**;顺序在 `assistant.message` 之前 |
| `assistant.reasoning-chunk` | `index?`,`text?`,`turn?`,`step?` | 思考的流式增量,**仅 `chunks:true`** |
| `assistant.message` | `text?`,`toolCalls?:[{id,name,arguments}]`,`turn?`,`step?` | 一次完整助手回复;`arguments` 是**原始 JSON 字符串**,需自行 parse |
| `assistant.chunk` | `chunk`,`turn?`,`step?` | **仅 `chunks:true`**;`chunk.type`:`text-delta` \| `reasoning-delta` \| `tool-call-delta` \| `block-start` \| `block-end` \| `usage` \| `finish` |
| `tool.call` | `callId`,`name`,`arguments`,`label?`,`turn?`,`step?` | `label` 是宿主给的人类可读标题(可能缺失);`arguments` 原始 JSON 字符串 |
| `tool.result` | `callId`,`ok`,`text?`,`error?:{name?,code?,message?}`,`turn?`,`step?` | 工具结果;`ok:false` 时看 `error` |
| `agent.error` | `message` | agent 异步失败信号(最终 res 的 `status` 会是 `failed`) |

### `session:<sessionId>`

同样的 kind 集合,外加:

| kind | 字段 | 说明 |
|---|---|---|
| `session.user-message` | `text` | 会话内某条用户输入的回显(多端同步用;自己发的那条也会收到) |
| `session.approval` | `pendingId`,`toolName`,`callId?`,`reason?` | **权限请求**:宿主需要批准才执行某操作(sandbox 升级、`ask` 工具调用)。客户端应弹确认框,回 `approval.respond` |

**审批流程**:收到 `session.approval` → UI 展示 `toolName`/`reason` → 用户点「允许/拒绝」→ 发 `approval.respond {sessionId, pendingId, allow}`。
`allow=true` = 本次授予(`allowed-once`);`false` = 拒绝。**先到先得**,多个订阅者里第一个合法回复生效,其余拿到 `approval.not.found`。
**超时兜底**:客户端不回复,服务端超时(默认 120s)自动拒绝,不会把 agent 卡死。宿主**没有「始终允许」**,每次审批都要单独回复。

**渲染建议**:`session.todo` 适合做任务清单面板;`assistant.reasoning` / `assistant.reasoning-chunk` 适合做可折叠的「思考区」;`tool.call.label` 可直接当工具行的标题(缺失时退回 `name`)。

前向兼容:**未知 `kind` 一律忽略**,不要报错。

---

## 5. 稳定错误码总表

帧级(出现在 `err`):`bad.frame`、`bad.size`

请求级(出现在 `res.ok:false`):`unknown.code`、`bad.request`、`internal`、`host.unavailable`、`agent.failed`、`agent.not.found`、`forbidden`、`session.not.found`、`session.busy`、`session.resume-failed`

---

## 6. 交互时序(示例)

单任务(发送方自动订阅):

```
client → {"v":1,"kind":"req","id":"r1","code":"agent.run","payload":{"prompt":"总结 README"}}
server → {"v":1,"kind":"evt","push":"task:remote-<uuid>","data":{"kind":"agent.status","status":"running"},"ts":...}
server → {"v":1,"kind":"evt","push":"task:remote-<uuid>","data":{"kind":"tool.call","callId":"c1","name":"read_file","arguments":"{\"path\":\"README.md\"}"},"ts":...}
server → {"v":1,"kind":"evt","push":"task:remote-<uuid>","data":{"kind":"tool.result","callId":"c1","ok":true,"text":"..."},"ts":...}
server → {"v":1,"kind":"evt","push":"task:remote-<uuid>","data":{"kind":"assistant.message","text":"总结如下…"},"ts":...}
server → {"v":1,"kind":"res","id":"r1","ok":true,"data":{"taskId":"remote-<uuid>","sessionId":"remote-<uuid>","status":"done","durationMs":4200}}
```

第三观察者(先订阅再观察别人的任务):

```
client → {"v":1,"kind":"sub","id":"s1","add":["task:remote-<uuid>"]}
server → {"v":1,"kind":"res","id":"s1","ok":true}
server → {"v":1,"kind":"evt","push":"task:remote-<uuid>", ...}   // 该任务后续事件
client → {"v":1,"kind":"sub","id":"s2","remove":["task:remote-<uuid>"]}
server → {"v":1,"kind":"res","id":"s2","ok":true}
```

---

## 7. 客户端落地要点

1. **按 `id` 派发 `res`**:并发请求用 map 存 `id → 回调/continuation`,不要依赖返回顺序。
2. **按 `push` 分主题、按 `data.kind` 分类型**处理 `evt`;未知 `kind` 忽略。
3. **多轮对话用 `session.*`,不要用 `agent.run`**:后者无状态,不会记得上文。
4. **不要假设 `assistant.message` 必到**:任务可能以 `agent.error` + `status:"failed"` 结束。
5. 帧大小自查:发大 `prompt` 前确认 < 256 KB。
6. 保活:按需发 `ping`(例如 30s 无流量时),以 `pong` 未回归判断链路不可用。
7. 重连:协议无会话恢复语义;重连后需重新 `sub`(自己发起的**新**任务/会话仍会自动订阅)。已有会话可直接 `session.send` 继续——**agent 侧上下文由服务端 resume 保证**。
8. `evt` 只发订阅者:如果"看不到事件",先确认自己是否订阅了该推送码(或任务/会话是否是自己发起的)。
9. 会话历史可能含宿主注入的上下文消息(`<system-reminder>` 等),按需过滤。

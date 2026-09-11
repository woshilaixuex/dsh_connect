# dsh-connect 线协议 v1(逐字段)

服务端是 dsh 宿主里的插件(`dsh-dsh-connect`),在 `hostName:listenPort` 上提供 WebSocket。
默认端口 **8097**(`DEFAULT_CONFIG.listenPort`);具体部署可能被 `.env` 覆盖(例如 `8080`),以服务端日志 `ws server listening on <host>:<port>` 为准。

- 传输:WebSocket,帧一律 **UTF-8 JSON 文本**;二进制帧不受支持(回帧级 `err`)
- 单帧上限 **256 KB**(`MAX_FRAME_BYTES`),超出回 `bad.size`
- 协议版本字段 `v` 恒为 `1`;`v` 不为 1 → 帧级 `bad.frame`
- **无鉴权**(局域网信任模型)
- `id` / `code` / 推送码:非空字符串,长度 ≤ 128

---

## 1. 帧信封

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
| `session.create` | `{ title? }` | `{ sessionId, title?, createdAt }` |
| `session.list` | `{ limit?, offset?, includeDeleted? }` | `{ sessions: [SessionSummary] }` |
| `session.get` | `{ sessionId }` | `SessionSummary` |
| `session.history` | `{ sessionId, limit? }` | `{ messages: [{ role, text, ts }] }` |
| `session.send` | `{ sessionId, prompt, chunks? }` | `{ sessionId, status, durationMs, error? }` |
| `session.stop` | `{ sessionId }` | `{ sessionId, status: 'stopped' }` |
| `session.delete` | `{ sessionId }` | `{ sessionId, deleted: true }` |

`SessionSummary` = `{ sessionId, title?, createdAt, lastActiveAt, lastMessage?, messageCount, live, deleted? }`(`live` = 当前是否有常驻 agent)

错误码:`session.not.found`、`session.resume-failed`、`bad.request`。

关键语义:

- **`session.create` 把发起连接自动订阅** `session:<sessionId>`;观察**别人创建**的会话需自己 `sub`。
- 同一会话的消息**串行执行**;不同会话并行。
- `session.stop` 只打断当前轮,**保留会话**;`session.delete` 是**软删**(宿主无删除 API,只从列表隐藏)。
- 历史里可能含宿主注入的上下文(`<system-reminder>` 等),客户端可按需过滤。

```jsonc
{"v":1,"kind":"req","id":"c1","code":"session.create","payload":{"title":"我的会话"}}
{"v":1,"kind":"req","id":"s1","code":"session.send","payload":{"sessionId":"sess-xxx","prompt":"记住:我叫蓝鲸"}}
{"v":1,"kind":"req","id":"s2","code":"session.send","payload":{"sessionId":"sess-xxx","prompt":"我叫什么?"}}   // agent 记得
{"v":1,"kind":"req","id":"h1","code":"session.history","payload":{"sessionId":"sess-xxx","limit":50}}
```

---

## 4. 推送码(下行事件)

### `task:<taskId>`

`evt.data` 按 `kind` 区分:

| kind | 字段 | 说明 |
|---|---|---|
| `agent.status` | `status`:`"running"` \| `"idle"` | agent 生命周期 |
| `assistant.message` | `text?`,`reasoningText?`,`toolCalls?:[{id,name,arguments}]`,`turn?`,`step?` | 一次完整助手回复;`arguments` 是**原始 JSON 字符串**,需自行 parse |
| `assistant.chunk` | `chunk`,`turn?`,`step?` | **仅 `chunks:true`**;`chunk.type`:`text-delta` \| `reasoning-delta` \| `tool-call-delta` \| `block-start` \| `block-end` \| `usage` \| `finish` |
| `tool.call` | `callId`,`name`,`arguments`,`turn?`,`step?` | 工具调用开始;`arguments` 原始 JSON 字符串 |
| `tool.result` | `callId`,`ok`,`text?`,`error?:{name?,code?,message?}`,`turn?`,`step?` | 工具结果;`ok:false` 时看 `error` |
| `agent.error` | `message` | agent 异步失败信号(最终 res 的 `status` 会是 `failed`) |

### `session:<sessionId>`

同样的 kind 集合,外加:

| kind | 字段 | 说明 |
|---|---|---|
| `session.user-message` | `text` | 会话内某条用户输入的回显(多端同步用;自己发的那条也会收到) |

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

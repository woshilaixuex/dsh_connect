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
| `session.create` | `{ title? }` | `{ sessionId, title?, createdAt }` | 新建会话并拉起常驻 agent;**发起连接自动订阅** `session:<sessionId>` |
| `session.list` | `{ limit?, offset?, includeDeleted? }` | `{ sessions: [{ sessionId, title?, createdAt, lastActiveAt, lastMessage?, messageCount, live, deleted? }] }` | 会话列表(默认不含软删) |
| `session.get` | `{ sessionId }` | 会话摘要 | 单个会话详情 |
| `session.history` | `{ sessionId, limit? }` | `{ messages: [{ role, text, ts }] }` | 消息历史(含 `user`/`assistant` 文本) |
| `session.send` | `{ sessionId, prompt, chunks? }` | `{ sessionId, status, durationMs, error? }` | 在会话里发一条消息(agent 记得上下文);同会话消息串行执行。**发起连接自动订阅** `session:<sessionId>` |
| `session.stop` | `{ sessionId }` | `{ sessionId, status }` | 打断当前轮,**保留会话** |
| `session.delete` | `{ sessionId }` | `{ sessionId, deleted: true }` | **软删**(宿主无删除 API,仅从本插件列表隐藏) |

**注意**:`session.create` 与 `session.send` 都会把**发起连接**自动加入 `session:<sessionId>`。
重启 dsh 后客户端重连、继续用旧会话时走的是 `send`,自动订阅保证你仍能收到事件流。

会话的「真相」是宿主 session(jsonl 持久化 + `agents.resume`):agent 空闲回收后再发消息会自动 `resume`,**上下文延续**。
索引(标题/时间/预览/软删标记)存在本插件 SQLite。

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
- `session:<sessionId>` —— 会话事件流(`session.create` 发起连接自动订阅;要观察别人的会话需显式 `sub`)。

事件载荷(`evt.data.kind`):

| kind | 载荷摘要 |
|---|---|
| `agent.status` | `{ status: 'running'\|'idle' }` |
| `session.user-message` | `{ text }`(会话内用户输入回显,便于多端同步) |
| `assistant.message` | `{ text?, reasoningText?, toolCalls?: [{id,name,arguments}], turn?, step? }` |
| `assistant.chunk` | `{ chunk, ... }`(仅 `chunks:true` 时推送,按 token 增量) |
| `tool.call` | `{ callId, name, arguments }`(arguments 为原始 JSON 字符串) |
| `tool.result` | `{ callId, ok, text?, error?, turn?, step? }` |
| `agent.error` | `{ message }` |

### 错误码

帧级:`bad.frame`、`bad.size`。请求级(`res ok:false`):`unknown.code`、`bad.request`、
`internal`、`host.unavailable`、`agent.failed`、`agent.not.found`、`forbidden`、
`session.not.found`、`session.busy`、`session.resume-failed`。

### 扩展

新增任务类型 = 在插件内 `hub.registerReceiver(code, handler)` 注册一个处理器
(handler 可经 `ctx` 调 `subscribe/publish` 产出自己的推送主题);代码见 `src/tasks/agent-task.ts`
与 `src/tasks/session-task.ts`。
# dsh_connect

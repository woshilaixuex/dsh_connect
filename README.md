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

| code | payload | res data | 说明 |
|---|---|---|---|
| `agent.run` | `{ prompt: string, cwd?, chunks? }` | `{ taskId, sessionId, status, durationMs }` | 把任务文本投给宿主 dsh agent 执行;**发起连接自动订阅** `task:<taskId>`,执行事件实时回推 |
| `agent.stop` | `{ taskId: string }` | `{ taskId, status }` | 停止任务(仅发起连接可停);连接断开也会自动停止其任务 |

### 推送码(下行事件)

客户端先 `sub` 订阅,服务端才推 `evt`。任务事件流使用**动态主题** `task:<taskId>`
(`agent.run` 的 res/首条事件前即可用,发起连接无需手动订阅)。

`agent.run` 事件载荷(`evt.data.kind`):

| kind | 载荷摘要 |
|---|---|
| `agent.status` | `{ status: 'running'\|'idle' }` |
| `assistant.message` | `{ text?, reasoningText?, toolCalls?: [{id,name,arguments}], turn?, step? }` |
| `assistant.chunk` | `{ chunk, ... }`(仅 `chunks:true` 时推送,按 token 增量) |
| `tool.call` | `{ callId, name, arguments }`(arguments 为原始 JSON 字符串) |
| `tool.result` | `{ callId, ok, text?, error?, turn?, step? }` |
| `agent.error` | `{ message }` |

### 错误码

帧级:`bad.frame`、`bad.size`。请求级(`res ok:false`):`unknown.code`、`bad.request`、
`internal`、`host.unavailable`、`agent.failed`、`agent.not.found`、`forbidden`。

### 扩展

新增任务类型 = 在插件内 `hub.registerReceiver(code, handler)` 注册一个处理器
(handler 可经 `ctx` 调 `subscribe/publish` 产出自己的推送主题);代码见 `src/tasks/agent-task.ts`。
# dsh_connect

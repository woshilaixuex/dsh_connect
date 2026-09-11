---
name: dsh-connect-capabilities
description: Catalog what the dsh-connect PC-side plugin already implements and how to reach each capability — how to start it in a dsh profile, the LAN WebSocket protocol entry points (receive codes agent.run/agent.stop, push topic task:<id>), the config/env surface, file logging, SQLite storage base, and the registered model tool. Also states what is NOT implemented yet. Use when asked what dsh-connect supports, whether a feature exists, how to connect a specific capability, or before adding a feature that may already be planned or built.
argument-hint: "[ws://host:port]"
metadata:
  protocol-version: "1"
---

# dsh-connect PC 端能力清单与接入方式

面向「这个插件现在到底能做什么、每项功能怎么连」的问题。**先跑探针确认当前实例的实况**,再查下表。

## 第一步:探测当前实例

```bash
node scripts/probe.mjs                       # 默认 ws://127.0.0.1:8097
node scripts/probe.mjs ws://192.168.1.10:8080
```

零依赖(Node 22 全局 `WebSocket`),**不触发真实推理**。输出每项能力是否在线:

```
✓ transport             WebSocket 已连接
✓ protocol              v1 握手正常
✓ frame-error-handling  坏帧回 bad.frame(连接保持)
✓ dispatcher            未知接收码回 unknown.code
✓ subscription          sub 订阅/退订可用
✓ receiver:agent.stop   已注册
✓ receiver:agent.run    已注册
```

探针只覆盖 WS 可见的能力。日志 / 存储 / 配置属**进程启动期**能力,查「逐项接入方式」。

---

## 能力总表

| # | 能力 | 接入方式 | 状态 |
|---|---|---|---|
| 1 | LAN WebSocket 服务(协议 v1) | `ws://<host>:<port>` JSON 帧 | ✅ 已实现 |
| 2 | 远程执行 dsh agent 任务 | 接收码 `agent.run` | ✅ 已实现(实机验证) |
| 3 | 停止运行中任务 | 接收码 `agent.stop` | ✅ 已实现 |
| 4 | 任务执行事件流 | 推送主题 `task:<taskId>` | ✅ 已实现 |
| 5 | **会话:多轮对话** | 接收码 `session.create` / `session.send` | ✅ 已实现(实机验证上下文延续) |
| 6 | **会话列表 / 历史 / 软删** | `session.list` / `session.history` / `session.get` / `session.delete` | ✅ 已实现 |
| 7 | **会话常驻 + resume 恢复** | 自动;空闲超时回收后退回 resume | ✅ 已实现(实机验证) |
| 8 | 会话事件流 | 推送主题 `session:<sessionId>` | ✅ 已实现 |
| 9 | 模型路由选择 | env / 宿主默认模型 | ✅ 已实现 |
| 10 | 配置面(env/.env/文件) | `DSH_CONNECT_*` | ✅ 已实现 |
| 11 | 文件日志(按天切分) | 读 `~/.dsh/logs/dsh-connect-*.log` | ✅ 已实现 |
| 12 | SQLite 存储基座 + 迁移器 | 直接开 db 文件 | ✅ 基座已实现(仅会话索引表) |
| 13 | 模型可见工具 `dsh_connect` | agent 调用 tools | ⚠️ echo 脚手架 |
| 14 | 鉴权 | — | ❌ 未实现 |
| 15 | 服务端主动心跳 | — | ❌ 未实现(仅应答 ping) |

**会话 vs 一次性任务**:`agent.run` 无状态、跑完即弃;要「记得上文」必须用会话族(`session.*`)。

---

## 逐项接入方式

### 0. 怎么让它跑起来(所有能力的前提)

dsh-connect 是 **Cordis 函数插件,跑在 dsh 进程内**,不能独立启动。

```powershell
# 1) 编译插件(在插件目录)
pnpm build

# 2) 起宿主(必须在 deepseek-harness 根目录,不是插件目录)
cd D:\Computer_development\project\deepseek-harness
pnpm dsh --profile dev-connect
```

装载链路:`~/.dsh/profiles/dev-connect/package.json` 的 `dsh.profile.bundles` 列出 `dsh-dsh-connect`
(依赖是 `link:` 指向插件项目)→ 读插件 `package.json` 的 `dsh.bundle.patch`(即 `cordis.patch.yml`)
→ 其中 `insert` 一条 `name: 'dsh-dsh-connect'` → Cordis 解析包 `main: lib/index.js` → 调用 `apply(ctx)`。

**关键**:dsh 加载 `lib/`(编译产物),改 `src/` 必须 `pnpm build`;**改完还要重启 dsh**
(`patchReload: live` 只热重载 patch 文件,`[hmr] watching []` 不重载模块)。

插件入口 `src/index.ts` 声明 `inject = ['tools']` —— 宿主没提供 `tools` 服务时插件不加载。

### 1. LAN WebSocket 服务(协议 v1)

**怎么连**:标准 WebSocket 连 `ws://<host>:<port>`;帧一律 UTF-8 JSON 文本。

- **端口**:代码默认 **8097**,但插件根 `.env` 的 `DSH_CONNECT_PORT` 会覆盖(本机实际是 **8080**)。
  以启动日志 `ws server listening on <host>:<port>` 为准,不是猜默认值。
- **地址**:默认 `hostName: 0.0.0.0`(监听所有网卡),局域网其它机器用 PC 的内网 IP 连。

**帧**:`req`/`sub`/`ping`(客户端→服务端),`res`/`evt`/`err`/`pong`(服务端→客户端)。
单帧 ≤ 256 KB;`v` 恒为 1;坏帧回帧级 `err` 且**不断连**。

字段级规格与客户端实现见兄弟 skill **`dsh-connect-client`**([protocol.md](../dsh-connect-client/references/protocol.md)、[kotlin-client.md](../dsh-connect-client/references/kotlin-client.md))。

### 2–4. 任务执行 / 停止 / 事件流(核心能力)

| 方向 | 码 | payload | 返回/说明 |
|---|---|---|---|
| 接收 | `agent.run` | `{prompt, cwd?, chunks?}` | res.data `{taskId, sessionId, status, durationMs, error?}`;`status` ∈ `done`/`stopped`/`failed` |
| 接收 | `agent.stop` | `{taskId}` | 仅发起连接可停;没有 → `agent.not.found` |
| 推送 | `task:<taskId>` | — | `evt.data.kind` 见下 |

事件载荷 `kind`:`agent.status` / `assistant.message` / `assistant.chunk`(仅 `chunks:true`)/ `tool.call` / `tool.result` / `agent.error`。

**订阅规则(最容易踩)**:`evt` 只发给订阅者;唯一自动订阅是「`agent.run` 把**发起连接**加入 `task:<taskId>`」。
其它连接想观察须先 `sub add:["task:<taskId>"]`。任务收尾自动退订,连接断开清空全部订阅。

**执行模型**:`ctx.agents.create({sessionId, agentOptions})` 拉起宿主 agent → `followup(UserMessage)` 投递
→ `whenIdle()` 等静默 → dispose。宿主事件经全局 `ctx.on('session/event'|'agent/status'|'agent/error')`
按 session/agent id 过滤后回推。

### 5–8. 会话(多轮对话)

| 方向 | 码 | payload | 返回/说明 |
|---|---|---|---|
| 接收 | `session.create` | `{ title? }` | res.data `{sessionId, title?, createdAt}`;**发起连接自动订阅** `session:<id>` |
| 接收 | `session.list` | `{ limit?, offset?, includeDeleted? }` | `{ sessions: [...] }`,含 `live` 标记(当前是否有常驻 agent) |
| 接收 | `session.get` | `{ sessionId }` | 单个摘要 |
| 接收 | `session.history` | `{ sessionId, limit? }` | `{ messages: [{role, text, ts}] }` |
| 接收 | `session.send` | `{ sessionId, prompt, chunks? }` | `{ sessionId, status, durationMs, error? }`;agent 记得上下文 |
| 接收 | `session.stop` | `{ sessionId }` | 打断**当前轮**,保留会话 |
| 接收 | `session.delete` | `{ sessionId }` | **软删**(宿主无删除 API,仅从列表隐藏) |
| 推送 | `session:<sessionId>` | — | 事件 kind 同 task 主题,另有 `session.user-message`(用户输入回显) |

**存储归属**:会话真相 = 宿主 session(JSONL 持久化在 `~/.dsh/sessions`);本插件 SQLite 只存**客户端侧索引**(标题/时间/预览/软删标记)。

**生命周期**:首次使用拉起常驻 agent → 空闲超时(默认 10min,`DSH_CONNECT_SESSION_IDLE_MS`)回收 → 再发消息自动 `ctx.agents.resume` **恢复上下文**(失败回退新建)。同会话消息**串行**执行,不同会话并行。

**注意**:

- 历史里可能含宿主注入的上下文消息(`<system-reminder>` 之类),客户端可按需过滤。
- `session.delete` 只隐藏索引,**宿主会话文件仍保留**(可用 `includeDeleted: true` 查到)。
- 要观察**别人创建**的会话,需显式 `sub session:<id>`(只有创建者自动订阅)。

### 9. 模型路由

不配则回退宿主服务 `ctx.agentDefaultModel`(base bundle 默认 `deepseek-official`/`deepseek-v4-flash`)。
要指定:

| env | 说明 |
|---|---|
| `DSH_CONNECT_AGENT_PROVIDER` | 必须与 `_MODEL` 成对 |
| `DSH_CONNECT_AGENT_MODEL` | 同上 |

**缺模型路由的症状**:`agent.run` 返回 `status:"failed"`,事件流里有 `agent.error`,message 含 `has no provider/model`。

### 10. 配置面

优先级(高 → 低):`setConfig()` 运行时覆盖 > 进程 env > 插件根 `.env` > `dsh-connect.config.json` > `DEFAULT_CONFIG`。

| env | 作用 | 默认 |
|---|---|---|
| `DSH_CONNECT_HOST` / `DSH_CONNECT_HOSTNAME` | 监听地址(前者优先) | `0.0.0.0` |
| `DSH_CONNECT_PORT` | WS 端口(非法/越界回退默认) | `8097` |
| `DSH_CONNECT_LOG_LEVEL` | `dev`/`debug`/`prod` | `dev` |
| `DSH_CONNECT_LOG_PATH` | 日志目录;相对路径基于 `~/.dsh`;**空 = 不落盘** | 未设(即不落盘) |
| `DSH_CONNECT_DB_PATH` | 数据库;**空串 = 禁用**;相对路径基于 `~/.dsh` | 未设(默认落 `~/.dsh/dsh-connect/dsh-connect.db`) |
| `DSH_CONNECT_AGENT_PROVIDER` / `_MODEL` | 模型路由 | 未设(用宿主默认) |
| `DSH_CONNECT_CONFIG` | 覆盖配置文件路径 | 插件根 `dsh-connect.config.json` |
| `DSH_CONNECT_DOTENV` | 设 `0` 禁用 `.env` 注入(测试隔离) | 未设 |

注:`.env` 只注入进程**尚未设置**的变量(真实 env 优先);Node 不自动读 `.env`,由 `loadDotEnv()` 基于 `import.meta.url` 定位插件根。

### 11. 文件日志

**怎么读**:`<DSH_CONNECT_LOG_PATH>/dsh-connect-YYYY-MM-DD.log`(按本地日期切分)。本机 `.env` 设了 `DSH_CONNECT_LOG_PATH=logs`,故实际在 `~/.dsh/logs/`。
行格式:`[ISO时间] [LEVEL] [name] 消息`。

- **级别过滤**:`dev`/`debug` 全量落盘(含 warn/debug);`prod` 只落 error/info。
- **同时**也会打到 console(exporter 是发布-订阅,多个 exporter 收到同一条)。
- 排查启动问题看这几行:`plugin loaded, config = {...}`、`file logging enabled at ...`、`sqlite database opened at ...`、`host agent service detected: agents|agentLoop`、`ws server listening on ...`。

### 12. SQLite 存储基座

**怎么连**:它就是一个普通 SQLite 文件,可用任意 sqlite 客户端打开。

- 默认路径:`~/.dsh/dsh-connect/dsh-connect.db`(相对 `DSH_CONNECT_DB_PATH` 基于 `~/.dsh`)。
- 打开时已设:WAL 模式、`foreign_keys=ON`、`busy_timeout=5000`;关闭幂等。
- 用 Node 22 内置 `node:sqlite`(`DatabaseSync`)——**无原生依赖**;启动时会打一条 `ExperimentalWarning` 属正常。
- 已含**会话索引表** `sessions`(id/title/created_at/last_active_at/last_message/message_count/deleted_at)+ `meta.schema_version` 迁移记录。
- `dbPath` 空串时禁用 SQLite,会话索引退化为**内存实现**(重启即丢,但宿主会话不受影响)。

### 13. 模型可见工具 `dsh_connect`

注册进宿主 `ctx.tools` 的工具,**由模型在推理中调用**(不是 WS 客户端直接调)。当前是 `dsh-dev` 脚手架保留的 echo 示例:

- 入参 `{ message: string }` → 出参 `{ ok: boolean, echoed: string }`,即回显。
- 用途:验证插件→宿主的 tool 注册链路通了。**不是业务能力**,可替换或删除。

### 14–15. 未实现 / 边界(明确没有的)

| 项 | 说明 |
|---|---|
| 鉴权 | 无任何认证,局域网信任模型;不要暴露到公网 |
| 服务端心跳定时器 | 只有客户端 `ping` → 服务端 `pong`;**服务端不主动探活** |
| 会话硬删除 | 宿主无删除 API,只能软删索引(文件仍在) |
| 会话归属隔离 | 局域网共享模型:任何连接可见/可发消息到任何会话 |
| 会话重命名 / 跨会话搜索 | 宿主标题自动生成;`openAt: never` 关闭了全文搜索 |
| 对外开放的 Cordis service | 接收器注册是**插件内部** API;其它插件无法 `ctx.xxx` 扩展 |
| 会话恢复 / 断线续传(客户端侧) | 协议无此语义;重连后自己发起的会话自动订阅,其它需重新 `sub` |
| 文件/图片上传、多用户隔离 | 无 |

---

## 扩展新能力的方式

**新增接收码** = 在插件内 `hub.registerReceiver(code, handler)` 一行注册(仅插件内部);
需要事件流就经 `RecvCtx.subscribe/publish` 自建推送主题。参考实现:`src/tasks/agent-task.ts`。
协议层不用动,新码对客户端即插即用。

## 服务端源码索引

| 关注点 | 文件 |
|---|---|
| 帧/错误码/上限 | `src/protocol/frame.ts` |
| 分派器 + 订阅表 + 断开清理 | `src/hub/hub.ts` |
| 宿主桥接(agents/agentLoop) | `src/bridge/agent-bridge.ts` |
| 宿主事件 → 线协议载荷 | `src/bridge/event-map.ts` |
| `agent.run` / `agent.stop` | `src/tasks/agent-task.ts` |
| WS 生命周期、帧分派 | `src/server/server.ts` |
| 配置面 | `src/config/config.ts` |
| 日志 exporter | `src/log/logger.ts` |
| SQLite 基座 | `src/store/store.ts` |

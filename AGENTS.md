# Memory

## Project Overview

dsh-connect 是一个 **dsh(DeepSeek Harness)插件**,目标是做 **LAN WebSocket 代理服务**:局域网客户端连上后提交任务文本,插件把任务转接给宿主 dsh 的 agent 执行(推理 + 工具调用),并把执行事件流式回传给客户端。持久化用 SQLite(存储基座已搭,业务表/迁移待补)。

当前进度:配置/日志 + **WS 协议 v1(双码分派)+ dsh agent 桥接 + 会话能力 + 会话/工作区镜像 + 思考/待办透传 + HTTP 只读接口 + 审批桥接**已实现;SQLite 存储基座已搭(业务表待补);鉴权未做。
- `src/config/config.ts` — 全局配置单例(env/.env/文件解析)
- `src/log/logger.ts` — Cordis FileExporter(按天落盘日志)
- `src/protocol/frame.ts` — 线协议:req/res/evt/sub/ping/pong 帧 + codec + 稳定错误码 + 推送码前缀(纯函数,不依赖 ws)
- `src/hub/hub.ts` — 消息枢纽:接收器注册表(registerReceiver)+ 推送主题订阅/发布 + 连接断开清理
- `src/bridge/agent-bridge.ts` — 宿主桥接:探测 agents/agentLoop 适配器,提供 create/resume,构造 UserMessage
- `src/bridge/event-map.ts` — 宿主 SessionEvent → 线协议载荷映射(纯函数,未知事件忽略)
- `src/sessions/session-index.ts` — 会话索引(SQLite + 内存两种实现:来源/标题/时间/预览/软删)+ schema 迁移
- `src/sessions/host-sessions.ts` — 宿主会话读取(列表/批量标题/存在性)——所有「问宿主」的唯一入口
- `src/sessions/session-mirror.ts` — 会话镜像:宿主会话 ∪ 索引 → 客户端视图(纯合并 + 降级)
- `src/sessions/session-registry.ts` — 会话常驻 agent:resume 回退/串行队列/空闲回收/内存历史/工具标签富化
- `src/sessions/persisted-history.ts` — 从宿主持久化会话读消息历史
- `src/workspace/workspace-source.ts` — 工作区来源:宿主 registry 优先,cwd 兜底分组
- `src/tasks/agent-task.ts` — 内置接收码 agent.run / agent.stop(一次性任务,主题 task:<id>)
- `src/tasks/session-task.ts` — 内置接收码 session.* + workspace.list(会话族,主题 session:<id>)
- `src/http/routes.ts` — HTTP 只读路由(纯函数:路径/查询 → 状态码 + JSON 体)
- `src/http/http-server.ts` — HTTP 服务(node:http,CORS + 每请求日志,独立端口)
- `src/server/server.ts` — WS server(createServer 工厂,返回 { dispose, hub, port, httpPort })
- `src/store/store.ts` — SQLite 存储基座(openDatabase + resolveDbPath + 迁移执行器)
- `src/index.ts` — 插件入口(apply,只起服务不改)
- `test/` — 单元 + e2e(node:test + tsx;e2e 用真实 ws 客户端连 127.0.0.1:0)
- `scripts/smoke.mjs` / `session-smoke.mjs` / `http-smoke.mjs` — 实机端到端冒烟(零依赖)

## 环境与命令(重要)

**dsh 本体不是 npm 全局安装,而是本地源码仓库**:
- dsh 源码:`D:\Computer_development\project\deepseek-harness`(monorepo,`package.json` 里 `"dsh"` script = `node --import tsx/esm apps/cli/src/bin.ts`)
- 插件项目:`D:\Computer_development\project\dsh-connect\dsh-connect`

**所有 dsh 命令必须在 deepseek-harness 根目录跑**(在插件目录跑 `pnpm dsh` 会报 Command not found):

```powershell
cd D:\Computer_development\project\deepseek-harness
pnpm dsh --profile dev-connect --dump-config   # 查看配置树(验证插件加载)
pnpm dsh --profile dev-connect                 # 启动(web 应用)
```

- 插件已装入 profile `dev-connect`(`C:\Users\cokea\.dsh\profiles\dev-connect`,pnpm link 方式)
- `dsh web` 是独立命令,**不接受 `--profile`**(混用会报错退出)
- dsh home = `C:\Users\cokea\.dsh`(profile/sessions/logs 都在这)

**插件构建与加载**:
- dsh 加载插件的是 `lib/`(编译产物,由 `package.json` `main` 指向),改 `src/` 必须 `pnpm build`
- 插件本地命令:在插件目录跑 `pnpm build`(tsc)/ `pnpm test`(tsx --test)

## 架构认知(Cordis/dsh 插件核心)

- 插件是 Cordis 函数插件:`export function apply(ctx)`;由 `cordis.patch.yml` 挂进 profile(dsh-connect 的 patch 把 `dsh-dsh-connect` 包作为 bundle 插入)
- 插件跑在 **dsh 进程内**,`ctx` 上有宿主服务:agents、sessions、tools、llm、approval、agentDefaultModel、logger;另有宿主私有 `agentLoop`(运行时存在、无公开类型)
- **把任务转接给 dsh 执行**(以下已在 store 类型 dsh-agent@0.0.1-rc.5 + deepseek-harness 源码/实机核实,别再用旧记忆的 `agentLoop.create(id,...)` 签名当主路径):
  - 正规入口 `ctx.agents.create({ sessionId, meta?, agentOptions?, setup? })` → `{ agent, dispose }`;agent 由其归属 handle 的 `dispose()` 释放
  - **必须以服务对象为接收者调用**:`create` 第一步就是 `this.ctx`,把方法解构出来裸调用会报 `Cannot read properties of undefined (reading 'ctx')`(实机踩过)
  - **root agent 必须给模型路由**:`agentOptions: { provider, model, reasoningEffort? }` 缺了会异步报 `agent "..." has no provider/model`;默认值来自宿主服务 `ctx.agentDefaultModel.currentSelection()`(base bundle 的 @deepseek-ai/dsh-agent-default-model,默认 deepseek-official/deepseek-v4-flash);插件可用 `DSH_CONNECT_AGENT_PROVIDER`/`_MODEL` 覆盖
  - `agent.followup(userMessage)` 投递并唤醒(入队即返回,无结果句柄);`agent.whenIdle()` 等静默;`agent.cancel({kind:'user'})` 打断
  - 消息是 `UserMessage`,四字段 `{ id, role:'user', content:[text块], source:{kind:'user'}}`;**没有 ChatMessage**
  - 事件订阅:Cordis 事件 **`session/event`(session, event)** 是会话持久日志火警,event.type 形如 `assistant/message`、`assistant/chunk`、`tool/call`、`tool/result`——**不存在**独立命名的 `assistant/*` 事件;另有 `agent/status`、`agent/error`
  - `agent/error` 是异步失败信号:agent-task 会把它记进 `lastError`,最终 res 的 status 变 `failed` 并带 `error` 字段(否则失败任务会假报 done)
  - "一次远程任务"边界 = `followup()` 成功到下一次 `whenIdle()`,期间把 session/event 映射后回推
  - 桥接实现见 `src/bridge/agent-bridge.ts`:探测顺序 agents → agentLoop 兜底;宿主类型不可 import,用最小结构类型 + `ctx.get()` 探测(见踩坑)
- **日志机制是发布-订阅 exporter**:发日志用 `ctx.logger('名字').info('fmt %s', v)`;收日志用 `ctx.logger.exporter(obj)` 注册(实现 `Exporter.export(message)`)。console 和文件 exporter 同时收到同一条消息
- 插件卸载清理用 `ctx.effect(() => () => {...}, 'label')`,不是 `ctx.on('dispose')`
- `ctx.get('dshHomePath')` 可拿到 home 路径函数(如 `dshHomePath('logs')` → `~/.dsh/logs`)
- 配置经 `cordis.patch.yml` 的 `config:` 进插件,函数插件签名 `apply(ctx, config)`

**WS 协议 v1(双码分派)**,实现散落 src/protocol|hub|tasks,README「WS 协议(v1)」是权威线协议文档:
- 帧一律 JSON 文本、单帧 ≤256KB(v 字段=1);req/res(带 id 关联)/evt/sub/ping/pong;坏帧回帧级 err 不断开连接
- 接收码 = req.code → hub 接收器注册表匹配处理器;处理器返回 → res ok data,抛 `TaskError(code,msg)` → res ok:false,其余异常 → internal
- 推送码 = 连接 sub 订阅的主题;`hub.publish` 的 evt 只发给订阅者(**未订阅不推,这是最容易踩的坑**)
- **自动订阅**:`agent.run` 把发起连接加入 `task:<id>`;`session.create` / **`session.send`** 加入 `session:<id>`。观察别人的会话/任务需显式 sub
  - `session.send` 的订阅是**必须的**:重启 dsh 后客户端重连、继续用旧会话时走的是 send(不是 create),漏订阅会导致 agent 照常执行、客户端却收不到任何 evt 而永远停在"运行中"(实机踩过)
- 一次性任务主题 `task:<taskId>`;会话主题 `session:<sessionId>`(前缀常量见 frame.ts 的 PushPrefix/sessionTopic/taskTopic)
- 事件载荷 data.kind:`agent.status` / `session.user-message`(会话内用户输入回显)/ `session.turn`(turn/start·end)/ `session.todo`(模型待办清单)/ `session.plan` / `assistant.reasoning`(**完整思考**,先于正文)/ `assistant.message` / `assistant.chunk` / `assistant.reasoning-chunk`(思考流式,仅 chunks:true)/ `tool.call`(带 `label`)/ `tool.result` / `agent.error`;映射见 src/bridge/event-map.ts
- `mapSessionEvent` 返回**数组**(一个宿主事件可产出多条线协议事件,如 reasoning + message);空数组=忽略
- `tool.call.label` 由 registry 用宿主 `ctx.tools.get(name)?.presentCall(args)?.title` 富化(拿不到就只有 name);`session.plan.pending` 由 `ctx.sessionProjections.stateOf(session,'plan')` 补
- 监听宿主事件一律用**全局** `ctx.on('session/event'|'agent/status'|'agent/error')` 再按 agent/session id 过滤(不用 agent 作用域,规避 scope 语义差异),任务收尾逐条 ctx.off

**会话能力**(src/sessions|tasks/session-task.ts):
- 会话真相 = 宿主 session(jsonl 持久化在 `~/.dsh/sessions`);本插件 SQLite 只存客户端侧索引(来源/标题/时间/预览/软删)
- **会话镜像**:`session.list` 返回「宿主会话 ∪ 本插件会话」。宿主侧提供 header(cwd/createdAt/live/persisted)与标题;索引提供 `source`、软删、预览、计数。宿主 listing 失败时降级为只用索引(记 warn)
- **来源标记**:`source: 'client'|'host'`。宿主**没有**可用字段(`header.origin` 只有 'subagent' 且是所有权判据,不可挪用)→ 只能存本插件索引。规则:id 前缀 `client-` → client;显式传入的 id 按宿主是否存在判定
- **复用会话**:`session.create` 传 `sessionId` 时,先探宿主是否存在(host-sessions.exists → sessionQuery.observeSession),存在则 source='host' 并走 resume;**这一步是必须的**(见踩坑:对已持久化 id 直接 create 会异步碰撞)
- **工作区**:`workspace.list` 优先 `ctx.workspaceRegistry`(返回 `source:'registry'`),缺失时按会话 `cwd` 分组(`source:'cwd'`)。**该服务不在 base bundle**(只在 web-app),dev-connect 需手工加装(见下)
- 常驻 agent + 空闲回收(默认 10min,`DSH_CONNECT_SESSION_IDLE_MS` 覆盖);回收后再发消息走 `ctx.agents.resume({resumeSessionId})` 恢复上下文,失败回退 create
- 同会话消息**串行**(promise 队列),不同会话可并行;`session.stop` 只打断当前轮,`session.delete` 是**软删**(宿主无删除 API)
- resume 起来的会话会把宿主持久化历史载入内存(否则 history 只有 resume 之后的消息);历史优先内存,未激活时读 `ctx.sessionQuery.readSession`
- **宿主两种事件的 data 形状不同**:`user/message` 的 data 本身就是消息;`assistant/message` 的是 `data.message`(踩过)

**审批桥接**(权限请求 ↔ 远程客户端,src/sessions/session-registry.ts + tasks/session-task.ts):
- 宿主 `approval/request` 是 **waterfall answerer** 事件:`(req, next) => Promise<ApprovalOutcome>`,返回 outcome = 认领、调 `next()` = 委托。`req = { agent, toolName, callId?, reason?, signal? }`,`ApprovalOutcome = 'allowed-once'|'rejected'|'cancelled'|'unavailable'`(**无「始终允许」**,只能逐次授予)
- registry 注册**全局** answerer:`ctx.on('approval/request', handler)`,对「active map 里有该 agent.id」的请求认领并挂起(返回 pending Promise),推 `session.approval` 到 `session:<id>`;其它 agent 调 `next()` 委托给 web UI(共存)
- 客户端回 `approval.respond { sessionId, pendingId, allow }` → `registry.respondApproval` 按 `pendingId` + `sessionId` 双重校验后 `settle('allowed-once'|'rejected')`,先到先得
- **超时兜底**:客户端不回复 → `approvalTimeoutMs`(默认 120000,`DSH_CONNECT_APPROVAL_TIMEOUT_MS`)后自动 `rejected`;timer `unref`(不阻进程退出)
- **取消**:`req.signal` abort → `cancelled`;release/disposeAll 时该会话未决审批一律 `cancelled`;settle 统一清 timer/abort listener/pending 项
- **注意测试**:审批超时依赖 `unref` timer,单测里 `await pending` 会触发 Node「事件循环已耗尽」→ 被 cancelledByParent 并连坐同 suite 后续用例;要用 `await new Promise(r => setTimeout(r, 60))`(ref timer)保持事件循环,同空闲回收测试写法

## Code Style Guidelines

- 使用中文注释与中文沟通
- Use descriptive variable names
- Follow existing patterns in the codebase
- Extract complex conditions into meaningful boolean variables
- LogLevel 等业务枚举用字符串值('dev'/'debug'/'prod'),便于 env/YAML 写入
- 线协议帧的解析/构造只走 src/protocol/frame.ts(parseFrame 纯函数不抛异常、帧工厂 + ErrorCodes 常量),不要手写 JSON.parse/序列化
- hub 处理器失败用 `throw new TaskError(code, message)`(code 用 ErrorCodes 或自定义稳定码),不要直接向连接发帧——回复由 hub.dispatch 统一负责
- 新增任务类型 = 新文件 + `hub.registerReceiver(code, handler)` 一行注册(仅插件内部);需要事件流就经 RecvCtx.subscribe/pub 自己建主题

## Architecture Notes

- **配置优先级**:`setConfig()` > 进程 env(DSH_CONNECT_*) > 插件根 `.env` > `dsh-connect.config.json` > DEFAULT_CONFIG
- **Node 不自动读 .env**;config.ts 的 `loadDotEnv()` 基于 `import.meta.url` 定位插件根,只注入进程未设置过的 `DSH_CONNECT_*` 变量;测试用 `DSH_CONNECT_DOTENV=0` 禁用
- **日志路径**:`logPath` 空 = 不落盘;相对路径基于 dsh home(`~/.dsh`);文件按本地日期切分 `dsh-connect-YYYY-MM-DD.log`
- **日志级别过滤**:DEV/DEBUG = 全量落盘(排查用);PROD = 只落 error/info(level<=1),丢 warn/debug
- **SQLite 基座**:用 Node 22 内置 `node:sqlite`(DatabaseSync,零依赖零原生编译;宿主 Node ≥22.5 才有);`dbPath` 语义同 logPath——undefined = 默认 `~/.dsh/dsh-connect/dsh-connect.db`,空串 = 禁用(会话索引退化为内存实现),相对路径基于 dsh home;env 用 `DSH_CONNECT_DB_PATH`(空串可禁,别用 `if (v)` 式解析);openDatabase 已开 WAL/foreign_keys/busy_timeout 5000,dispose 幂等;`migrate(db, migrations)` 是顺序迁移执行器(meta.schema_version + 逐条事务),会话表在 src/sessions/session-index.ts 的 MIGRATIONS
- **会话索引/注册表**:索引有 SQLite 与内存两套实现(同接口,测试对两者跑同一组断言);注册表用一组全局宿主监听分发到各会话主题,而非每会话挂一组
- **Server 生命周期**:用 `createServer(ctx, config)` 工厂创建(不在模块顶层 new,避免副作用/端口泄漏),`ctx.effect` 注册 dispose;返回 `{ dispose, hub, port, httpPort }`,hub 是插件内部扩展点(注册接收器/推送),port/httpPort 是 Promise(配置 0 时拿随机端口,e2e 用);`createServer(ctx, config, { sessionIndex })` 可注入索引
- **Server 容错**:帧级 err 不关连接;单连接 send 失败不外抛;端口绑定失败(EADDRINUSE)时 port 回退配置值、dispose 不悬挂。**WS 与 HTTP 互相隔离**:任一端口失败不影响另一个
- **默认监听端口 8097**(config.ts DEFAULT_CONFIG.listenPort;`test/config.test.ts` 断言同步 8097);本机插件根 `.env` 实际设了 `DSH_CONNECT_PORT=8080`,所以实跑监听 8080
- **HTTP 只读接口**:独立端口,默认 **8098**(`DSH_CONNECT_HTTP_PORT` 覆盖,`-1` 禁用);只 GET/HEAD(写操作仍走 WS),CORS 全开,无鉴权;路由 `/health` `/workspaces` `/sessions` `/sessions/:id/history`;数据复用 session-mirror/workspace-source/persisted-history,不重算;**无缓存**(每次实时读宿主)。routes.ts 是纯函数(好测),http-server.ts 只管 socket + CORS + 每请求日志
- **模型路由**:远程任务/会话默认走宿主 `agentDefaultModel`;要指定就用 `agentProvider`/`agentModel`(env `DSH_CONNECT_AGENT_PROVIDER`/`DSH_CONNECT_AGENT_MODEL`,必须成对)
- **会话空闲回收**:`sessionIdleTimeoutMs` 默认 600000(10min),env `DSH_CONNECT_SESSION_IDLE_MS`;验证 resume 时要把它设短(如 5000)并配合冒烟脚本的 `SMOKE_IDLE_WAIT_MS`
- **审批超时**:`approvalTimeoutMs` 默认 120000(2min),env `DSH_CONNECT_APPROVAL_TIMEOUT_MS`;客户端不回复自动拒绝(失败关闭)。答案 answerer 的 `ctx.on('approval/request', handler)` 在 registry 创建时注册、disposeAll 时 `ctx.off`
- **宿主服务可用性(base bundle 才有的才算默认可用)**:`sessionQuery`/`sessionProjections`/`session-title`/`tool-todo` 在 base ✅;**`workspaceRegistry` 只在 web-app bundle**,dev-connect 需加装(见「宿主侧加装 workspace」)。代码一律 feature-detect + 降级,不硬依赖
- 配置/日志/服务定位一律不依赖 `process.cwd()`(跑在 dsh 里时 cwd 是启动目录,不可靠)

### 宿主侧加装 workspace(可选,一次性)

`~/.dsh/profiles/dev-connect/`:

1. `package.json` dependencies 加 `"@deepseek-ai/dsh-workspace": "link:D://Computer_development//project//deepseek-harness//packages//workspace//workspace"`
2. `cordis.patch.yml` 加一条 insert:
   ```yaml
   - insert:
       - id: workspace
         name: '@deepseek-ai/dsh-workspace'
   ```
3. `pnpm install`(在 profile 目录)→ 会建 `node_modules/@deepseek-ai/dsh-workspace` 软链
4. 重启 dsh,`workspace.list` 应返回 `source: 'registry'`

**注意**:`dsh-dsh-connect` 是 **bundle**(由它自己的 `cordis.patch.yml` 插入),**不要**在 profile patch 里再 insert 它 —— 会报 `duplicate loader entry id: dsh-connect`(实机踩过)。改这些文件前先备份。

## Common Workflows

- **验证插件改动**:插件目录 `pnpm build` → deepseek-harness 目录 `pnpm dsh --profile dev-connect` 后台起 → 看 `~/.dsh/logs/dsh-connect-*.log`
- **端到端冒烟**:`node scripts/smoke.mjs`(agent.run,连 127.0.0.1:8080,可用 `DSH_CONNECT_SMOKE_URL` 覆盖);`--no-agent` 只跑协议检查不触发宿主推理。会话能力用 `node scripts/session-smoke.mjs`;HTTP 接口用 `node scripts/http-smoke.mjs http://127.0.0.1:8098`。验证 resume 需服务端设短 `DSH_CONNECT_SESSION_IDLE_MS` 并给脚本设 `SMOKE_IDLE_WAIT_MS`(大于该阈值)。**改了 `lib/` 必须重启 dsh**(patchReload 只热重载 patch 文件,`[hmr] watching []` 不重载模块)
- **实机校准 agent 桥接**:启动 dsh 后查日志里的 `host agent service detected: agents|agentLoop`(确认走了哪条适配器);再跑冒烟脚本看 `task:<id>` 事件流与最终 res
- **写测试**:`test/*.test.ts`,node:test + tsx;`pnpm test` 运行;临时目录用 mkdtempSync + afterEach 清理;纯逻辑层用假连接(FakeConn 收集 send,见 test/helpers.ts),协议/订阅/清理用真实 ws 连 `127.0.0.1:0`(port 从 server.port 拿,见 test/server.test.ts)
- **启动 dsh 后要停干净**:后台起 dsh 时杀掉进程树(cmd 包装进程 + node 子进程都要杀),否则残留 node 占配置端口(默认 8097)→ 下次启动 EADDRINUSE(用 `netstat -ano | findstr :8097` 找占用 PID)

## 踩坑记录

- `pnpm dsh` 必须在 deepseek-harness 根目录,不在插件目录
- `dsh --profile dev-connect web` 是非法组合;直接 `pnpm dsh --profile dev-connect`
- 文件日志最初 `%s/%d/%o` 不替换(Message.args 是原始参数),需用 Cordis `Logger.format(exporter, message)`(循环引用对象会抛错,需 try 回退)
- npm install 在这台机器常超时,用 pnpm;pnpm 需要 `allowBuilds` 允许 esbuild 等构建脚本
- 插件 node_modules 只有 cordis + dsh-tools;宿主类型(@deepseek-ai/dsh-agent 等)需额外安装才能 import
- **实机两连坑(桥接层已修)**:`ctx.agents.create` 解构丢 this → 报 `reading 'ctx' of undefined`(必须 `create.call(service, ...)`);root agent 不带 `agentOptions.provider/model` → 报 `has no provider/model`(回退 `ctx.agentDefaultModel`)。详见「架构认知」
- **FileExporter 必须声明 `levels`**:Cordis 过滤规则是 `(exporter.levels?.[name] ?? exporter.levels?.default ?? logger.level ?? 1) < level → 丢弃`,默认阈值 1 会把 **warn(2)/debug(3) 静默拦掉**(实机排查时才发现日志里一条 WARN 都没有);已设 `levels = { default: 3 }`,再由 FileExporter 自己的 PROD 逻辑过滤
- **客户端收不到 evt 先查订阅**:`publish` 只发给订阅者。一次性任务/会话的发起连接会自动订阅各自主题;其它连接(`sub` 加入别人的会话、观察他人任务)必须显式订阅
- **沙箱/审批**:宿主 base bundle 默认 `DSH_PERMISSION_MODE=workspace-write` + approval `ask`。**远程会话的审批已桥接**(见「审批桥接」):会推 `session.approval` 给客户端、等 `approval.respond`;客户端不实现则超时自动拒绝(agent 优雅降级继续)。web UI 会话的审批仍走 web UI,互不干扰。要彻底放开权限需在宿主侧设 `DSH_PERMISSION_MODE=danger-full-access`(安全含义自负)
- **宿主事件 data 形状不统一**:`user/message` 的 `data` 本身就是消息(`data.content`);`assistant/message` 的是 `data.message`。读历史时按 `data.message ?? data` 兜底,否则**用户消息会整段丢失**(实机踩过)
- **宿主公开类型里不存在 `agentLoop`**(store 全量 d.ts 检索 0 命中):`ctx.agents`(AgentRegistry,dsh-agent@0.0.1-rc.5)才是正规 API;AGENTS 旧记忆的 `ctx.agentLoop.create(id,...)` 是宿主运行时私有服务,只在 deepseek-harness 进程里存在、无 npm 类型——桥接顺序 agents → agentLoop 兜底,勿倒置
- **对已持久化但非 live 的 id 直接 `agents.create` 不会即时抛错**,而是在首次 flush/dispose 异步报 `session "..." already has a persisted log on disk (id collision)` → **必须 resume-first**(registry 的 `probeSession` 注入 host-sessions.exists;索引存在性不可靠)
- **profile patch 不要重复 insert `dsh-dsh-connect`**:它是 bundle,自己的 `cordis.patch.yml` 已插入,再插一次会报 `duplicate loader entry id: dsh-connect`(实机踩过,且 HMR 会把这个错误刷进日志)
- 宿主事件形态:会话事件在 `session/event` 的 event.type 里(`assistant/message` 等),不是 Cordis 顶层事件名;事件订阅/退订用全局 ctx.on/off + 按 id 过滤
- `.pnpm store` 里 dsh 包版本是"dsh-tools peer 解析出的混装"(dsh-agent rc.5 + 其它 rc.1),只能当类型参考,和宿主实际装的不一定同版(宿主是 monorepo 源码);运行时一律结构探测 + 容错映射
- 测试默认参数 `x ?? 默认` 会把显式 null 当空值回退——需要"无宿主"这类显式空场景时传非空哨兵(如 false),不能传 null/undefined
- build 后 lib/ 才是 dsh 真正加载的产物;本地用 `pnpm exec tsx --test <文件>` 可只跑单个测试文件

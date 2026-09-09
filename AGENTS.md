# Memory

## Project Overview

dsh-connect 是一个 **dsh(DeepSeek Harness)插件**,目标是做 **LAN WebSocket 代理服务**:局域网客户端连上后提交任务文本,插件把任务转接给宿主 dsh 的 agent 执行(推理 + 工具调用),并把执行事件流式回传给客户端。持久化用 SQLite(存储基座已搭,业务表/迁移待补)。

当前进度:配置/日志 + **WS 协议 v1(双码分派)+ dsh agent 桥接**已实现;SQLite 存储基座已搭(业务表/迁移/鉴权/心跳未做)。
- `src/config/config.ts` — 全局配置单例(env/.env/文件解析)
- `src/log/logger.ts` — Cordis FileExporter(按天落盘日志)
- `src/protocol/frame.ts` — 线协议:req/res/evt/sub/ping/pong 帧 + codec + 稳定错误码(纯函数,不依赖 ws)
- `src/hub/hub.ts` — 消息枢纽:接收器注册表(registerReceiver)+ 推送主题订阅/发布 + 连接断开清理
- `src/bridge/agent-bridge.ts` — 宿主桥接:探测 agents/agentLoop 适配器,构造 UserMessage
- `src/bridge/event-map.ts` — 宿主 SessionEvent → 线协议载荷映射(纯函数,未知事件忽略)
- `src/tasks/agent-task.ts` — 内置接收码 agent.run / agent.stop(执行任务并把事件回推到 task:<taskId>)
- `src/server/server.ts` — WS server(createServer 工厂,返回 { dispose, hub, port })
- `src/store/store.ts` — SQLite 存储基座(openDatabase + resolveDbPath,WAL/外键/busy_timeout)
- `src/index.ts` — 插件入口(apply,只起服务不改)
- `test/` — 单元 + e2e(node:test + tsx;e2e 用真实 ws 客户端连 127.0.0.1:0)

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
- 插件跑在 **dsh 进程内**,`ctx` 上有宿主服务:agents、sessions、tools、llm、approval、logger;另有宿主私有 `agentLoop`(运行时存在、无公开类型)
- **把任务转接给 dsh 执行**(以下已在 store 类型 dsh-agent@0.0.1-rc.5 核实,别再用旧记忆的 `agentLoop.create(id,...)` 签名当主路径):
  - 正规入口 `ctx.agents.create({ sessionId, meta?, agentOptions?, setup? })` → `{ agent, dispose }`;agent 由其归属 handle 的 `dispose()` 释放
  - `agent.followup(userMessage)` 投递并唤醒(入队即返回,无结果句柄);`agent.whenIdle()` 等静默;`agent.cancel({kind:'user'})` 打断
  - 消息是 `UserMessage`,四字段 `{ id, role:'user', content:[text块], source:{kind:'user'}}`;**没有 ChatMessage**
  - 事件订阅:Cordis 事件 **`session/event`(session, event)** 是会话持久日志火警,event.type 形如 `assistant/message`、`assistant/chunk`、`tool/call`、`tool/result`——**不存在**独立命名的 `assistant/*` 事件;另有 `agent/status`、`agent/error`
  - "一次远程任务"边界 = `followup()` 成功到下一次 `whenIdle()`,期间把 session/event 映射后回推
  - 桥接实现见 `src/bridge/agent-bridge.ts`:探测顺序 agents → agentLoop 兜底;宿主类型不可 import,用最小结构类型 + `ctx.get()` 探测(见踩坑)
- **日志机制是发布-订阅 exporter**:发日志用 `ctx.logger('名字').info('fmt %s', v)`;收日志用 `ctx.logger.exporter(obj)` 注册(实现 `Exporter.export(message)`)。console 和文件 exporter 同时收到同一条消息
- 插件卸载清理用 `ctx.effect(() => () => {...}, 'label')`,不是 `ctx.on('dispose')`
- `ctx.get('dshHomePath')` 可拿到 home 路径函数(如 `dshHomePath('logs')` → `~/.dsh/logs`)
- 配置经 `cordis.patch.yml` 的 `config:` 进插件,函数插件签名 `apply(ctx, config)`

**WS 协议 v1(双码分派)**,实现散落 src/protocol|hub|tasks,README「WS 协议(v1)」是权威线协议文档:
- 帧一律 JSON 文本、单帧 ≤256KB(v 字段=1);req/res(带 id 关联)/evt/sub/ping/pong;坏帧回帧级 err 不断开连接
- 接收码 = req.code → hub 接收器注册表匹配处理器;处理器返回 → res ok data,抛 `TaskError(code,msg)` → res ok:false,其余异常 → internal
- 推送码 = 连接 sub 订阅的主题;`hub.publish` 的 evt 只发给订阅者(未订阅不推);任务事件主题是动态 `task:<taskId>`,agent.run 把发起连接自动加入、任务收尾自动退订
- agent.run 事件载荷 data.kind:`agent.status` / `assistant.message` / `assistant.chunk`(仅 payload.chunks:true)/ `tool.call` / `tool.result` / `agent.error`;映射逻辑见 src/bridge/event-map.ts
- 监听宿主事件一律用**全局** `ctx.on('session/event'|'agent/status'|'agent/error')` 再按 agent/session id 过滤(不用 agent 作用域,规避 scope 语义差异),任务收尾逐条 ctx.off

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
- **SQLite 基座**:用 Node 22 内置 `node:sqlite`(DatabaseSync,零依赖零原生编译;宿主 Node ≥22.5 才有);`dbPath` 语义同 logPath——undefined = 默认 `~/.dsh/dsh-connect/dsh-connect.db`,空串 = 禁用,相对路径基于 dsh home;env 用 `DSH_CONNECT_DB_PATH`(空串可禁,别用 `if (v)` 式解析);openDatabase 已开 WAL/foreign_keys/busy_timeout 5000,dispose 幂等;业务表/迁移后续再补(见 src/store/store.ts)
- **Server 生命周期**:用 `createServer(ctx, config)` 工厂创建(不在模块顶层 new,避免副作用/端口泄漏),`ctx.effect` 注册 dispose;返回 `{ dispose, hub, port }`,hub 是插件内部扩展点(注册接收器/推送),port 是 Promise(配置 0 时拿随机端口,e2e 用)
- **Server 容错**:帧级 err 不关连接;单连接 send 失败不外抛;端口绑定失败(EADDRINUSE)时 port 回退配置值、dispose 不悬挂
- **默认监听端口 8097**(config.ts DEFAULT_CONFIG.listenPort;`test/config.test.ts` 断言同步 8097)
- 配置/日志/服务定位一律不依赖 `process.cwd()`(跑在 dsh 里时 cwd 是启动目录,不可靠)

## Common Workflows

- **验证插件改动**:插件目录 `pnpm build` → deepseek-harness 目录 `pnpm dsh --profile dev-connect` 后台起 → 看 `~/.dsh/logs/dsh-connect-*.log`
- **实机校准 agent 桥接**:启动 dsh 后查日志里的 `host agent service detected: agents|agentLoop`(确认走了哪条适配器);再起一个 ws 客户端发 `agent.run`,看 `task:<id>` 事件流与最终 res
- **写测试**:`test/*.test.ts`,node:test + tsx;`pnpm test` 运行;临时目录用 mkdtempSync + afterEach 清理;纯逻辑层用假连接(FakeConn 收集 send,见 test/helpers.ts),协议/订阅/清理用真实 ws 连 `127.0.0.1:0`(port 从 server.port 拿,见 test/server.test.ts)
- **启动 dsh 后要停干净**:后台起 dsh 时杀掉进程树(cmd 包装进程 + node 子进程都要杀),否则残留 node 占配置端口(默认 8097)→ 下次启动 EADDRINUSE(用 `netstat -ano | findstr :8097` 找占用 PID)

## 踩坑记录

- `pnpm dsh` 必须在 deepseek-harness 根目录,不在插件目录
- `dsh --profile dev-connect web` 是非法组合;直接 `pnpm dsh --profile dev-connect`
- 文件日志最初 `%s/%d/%o` 不替换(Message.args 是原始参数),需用 Cordis `Logger.format(exporter, message)`(循环引用对象会抛错,需 try 回退)
- npm install 在这台机器常超时,用 pnpm;pnpm 需要 `allowBuilds` 允许 esbuild 等构建脚本
- 插件 node_modules 只有 cordis + dsh-tools;宿主类型(@deepseek-ai/dsh-agent 等)需额外安装才能 import
- **宿主公开类型里不存在 `agentLoop`**(store 全量 d.ts 检索 0 命中):`ctx.agents`(AgentRegistry,dsh-agent@0.0.1-rc.5)才是正规 API;AGENTS 旧记忆的 `ctx.agentLoop.create(id,...)` 是宿主运行时私有服务,只在 deepseek-harness 进程里存在、无 npm 类型——桥接顺序 agents → agentLoop 兜底,勿倒置
- 宿主事件形态:会话事件在 `session/event` 的 event.type 里(`assistant/message` 等),不是 Cordis 顶层事件名;事件订阅/退订用全局 ctx.on/off + 按 id 过滤
- `.pnpm store` 里 dsh 包版本是"dsh-tools peer 解析出的混装"(dsh-agent rc.5 + 其它 rc.1),只能当类型参考,和宿主实际装的不一定同版(宿主是 monorepo 源码);运行时一律结构探测 + 容错映射
- 测试默认参数 `x ?? 默认` 会把显式 null 当空值回退——需要"无宿主"这类显式空场景时传非空哨兵(如 false),不能传 null/undefined
- build 后 lib/ 才是 dsh 真正加载的产物;本地用 `pnpm exec tsx --test <文件>` 可只跑单个测试文件

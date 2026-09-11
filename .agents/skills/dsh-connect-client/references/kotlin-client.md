# Kotlin / Android 参考客户端

用 OkHttp 的 WebSocket + kotlinx.serialization。核心是把「帧的路由」做成一个薄层,
上层按 `id` 等 `res`、按 `push` + `data.kind` 收事件。

覆盖两条主干:**一次性任务**(`agent.run`)与**多轮会话**(`session.*`,上下文由服务端 resume 保证)。

依赖:

```kotlin
implementation("com.squareup.okhttp3:okhttp:4.12.0")
implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
```

---

## 0. Android 特有的三个坑(先看这个)

1. **明文流量**:`ws://` 属明文。Android 9+ 默认禁止,直接连会失败(通常报 `CLEARTEXT communication not permitted`)。
   开发期在 `AndroidManifest.xml` 的 `<application>` 上加 `android:usesCleartextTraffic="true"`,
   或更稳的做法加 `networkSecurityConfig` 只对局域网网段放行。
2. **权限**:`AndroidManifest.xml` 需要 `<uses-permission android:name="android.permission.INTERNET"/>`。
3. **别在 UI 线程收发**:OkHttp 回调在 OkHttp 自己的线程;用协程把帧投到 `Channel`/`SharedFlow` 再消费。

---

## 1. 帧模型(kotlinx.serialization)

`data`/`payload` 用 `JsonElement` 承载,这样**未知 `data.kind` 不会解析失败**(协议要求前向兼容)。

```kotlin
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

@Serializable
data class Frame(
    val v: Int = PROTOCOL_VERSION,
    val kind: String,
    // req
    val id: String? = null,
    val code: String? = null,
    val payload: JsonElement? = null,
    // res
    val ok: Boolean? = null,
    val data: JsonElement? = null,
    val message: String? = null,
    // evt
    val push: String? = null,
    val ts: Long? = null,
    // sub
    val add: List<String>? = null,
    val remove: List<String>? = null,
)

const val PROTOCOL_VERSION = 1
const val MAX_FRAME_BYTES = 256 * 1024

object Codes {
    // 帧级
    const val BAD_FRAME = "bad.frame"
    const val BAD_SIZE = "bad.size"
    // 请求级
    const val UNKNOWN_CODE = "unknown.code"
    const val BAD_REQUEST = "bad.request"
    const val INTERNAL = "internal"
    const val HOST_UNAVAILABLE = "host.unavailable"
    const val AGENT_FAILED = "agent.failed"
    const val AGENT_NOT_FOUND = "agent.not.found"
    const val FORBIDDEN = "forbidden"
    // 会话族
    const val SESSION_NOT_FOUND = "session.not.found"
    const val SESSION_BUSY = "session.busy"
    const val SESSION_RESUME_FAILED = "session.resume-failed"
}

// ignoreUnknownKeys 让服务端加字段不炸;explicitNulls=false 让省略字段不发 null
val json = Json { ignoreUnknownKeys = true; explicitNulls = false; encodeDefaults = false }
```

会话相关的两个 DTO(从 `JsonElement` 手工映射,保持前向兼容):

```kotlin
import kotlinx.serialization.json.*

/** 会话里的一条消息。 */
data class WireMessage(
    val role: String,     // "user" | "assistant"
    val text: String,
    val ts: Long,
)

/** 会话摘要。 */
data class SessionSummary(
    val sessionId: String,
    val title: String?,
    val createdAt: Long,
    val lastActiveAt: Long,
    val lastMessage: String?,
    val messageCount: Int,
    val live: Boolean,        // 当前是否有常驻 agent
    val deleted: Boolean,
)

fun JsonElement.toWireMessage(): WireMessage {
    val o = jsonObject
    return WireMessage(
        role = o["role"]?.jsonPrimitive?.content ?: "assistant",
        text = o["text"]?.jsonPrimitive?.content ?: "",
        ts = o["ts"]?.jsonPrimitive?.longOrNull ?: 0L,
    )
}

fun JsonElement.toSessionSummary(): SessionSummary {
    val o = jsonObject
    return SessionSummary(
        sessionId = o["sessionId"]!!.jsonPrimitive.content,
        title = o["title"]?.jsonPrimitive?.contentOrNull,
        createdAt = o["createdAt"]?.jsonPrimitive?.longOrNull ?: 0L,
        lastActiveAt = o["lastActiveAt"]?.jsonPrimitive?.longOrNull ?: 0L,
        lastMessage = o["lastMessage"]?.jsonPrimitive?.contentOrNull,
        messageCount = o["messageCount"]?.jsonPrimitive?.intOrNull ?: 0,
        live = o["live"]?.jsonPrimitive?.booleanOrNull ?: false,
        deleted = o["deleted"]?.jsonPrimitive?.booleanOrNull ?: false,
    )
}
```

发送构造:

```kotlin
fun req(id: String, code: String, payload: kotlinx.serialization.json.JsonObject? = null) =
    Frame(kind = "req", id = id, code = code, payload = payload)

fun sub(add: List<String>? = null, remove: List<String>? = null, id: String? = null) =
    Frame(kind = "sub", id = id, add = add, remove = remove)

val PING = Frame(kind = "ping")
```

---

## 2. 客户端

```kotlin
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import okhttp3.*
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

class DshConnectClient(
    private val baseUrl: String,              // e.g. "ws://192.168.1.10:8080"
    private val scope: CoroutineScope,
) {
    private val http = OkHttpClient.Builder()
        // LAN 场景:关掉代理探测,保活交给应用层 ping
        .retryOnConnectionFailure(true)
        .build()

    /** res 等待者:id → Deferred。响应可能乱序,必须按 id 派发。 */
    private val pending = ConcurrentHashMap<String, CompletableDeferred<Frame>>()

    /** 所有推送帧(evt),上层按 push + data.kind 分流。 */
    private val _events = MutableSharedFlow<Frame>(extraBufferCapacity = 256)
    val events: SharedFlow<Frame> = _events

    /** 连接状态。 */
    private val _state = MutableStateFlow(ConnState.CLOSED)
    val state: StateFlow<ConnState> = _state

    private var socket: WebSocket? = null
    private var pingJob: Job? = null

    enum class ConnState { CLOSED, CONNECTING, OPEN }

    private val listener = object : WebSocketListener() {
        override fun onOpen(ws: WebSocket, response: Response) {
            socket = ws
            _state.value = ConnState.OPEN
            startPing(ws)
        }

        override fun onMessage(ws: WebSocket, text: String) {
            val frame = runCatching { json.decodeFromString<Frame>(text) }.getOrNull()
            if (frame == null) return                    // 非 JSON/坏帧:忽略
            when (frame.kind) {
                "res" -> frame.id?.let { pending.remove(it)?.complete(frame) }
                "evt" -> _events.tryEmit(frame)             // 未知 kind 也照样抛给上层
                "err" -> _events.tryEmit(frame)             // 帧级错误:上报,不断连
                "pong" -> {}                                // 保活应答
            }
        }

        override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
            _state.value = ConnState.CLOSED
            failAllPending(t)
        }

        override fun onClosing(ws: WebSocket, code: Int, reason: String) {
            ws.close(1000, null)
        }

        override fun onClosed(ws: WebSocket, code: Int, reason: String) {
            stopPing()
            _state.value = ConnState.CLOSED
        }
    }

    fun connect() {
        if (_state.value != ConnState.CLOSED) return
        _state.value = ConnState.CONNECTING
        socket = http.newWebSocket(
            Request.Builder().url(baseUrl).build(),
            listener,
        )
    }

    fun close() {
        stopPing()
        socket?.close(1000, "client closing")
        socket = null
        _state.value = ConnState.CLOSED
    }

    /** 发一帧;顺带做 256KB 上限自查。 */
    private fun sendRaw(frame: Frame): Boolean {
        val ws = socket ?: return false
        val text = json.encodeToString(frame)
        if (text.toByteArray(Charsets.UTF_8).size > MAX_FRAME_BYTES) {
            throw IllegalArgumentException("帧超过 $MAX_FRAME_BYTES 字节上限")
        }
        return ws.send(text)
    }

    /** 发请求并挂起等 res(超时抛 TimeoutCancellationException)。 */
    suspend fun request(
        code: String,
        payload: JsonObject? = null,
        timeoutMs: Long = 30_000,
    ): Frame = coroutineScope {
        val id = UUID.randomUUID().toString()
        val deferred = CompletableDeferred<Frame>()
        pending[id] = deferred
        try {
            if (!sendRaw(req(id, code, payload))) error("连接未就绪")
            withTimeout(timeoutMs) { deferred.await() }
        } finally {
            pending.remove(id)
        }
    }

    // ── 语义化封装:一次性任务 ──────────────────────────────────────────────

    /** 提交任务。事件会从 events 流里以 push == "task:$taskId" 到达。 */
    suspend fun runAgent(prompt: String, cwd: String? = null, chunks: Boolean = false): Frame {
        val payload = buildJsonObject {
            put("prompt", prompt)
            cwd?.let { put("cwd", it) }
            put("chunks", chunks)
        }
        return request("agent.run", payload, timeoutMs = 10 * 60_000)  // 长任务放宽超时
    }

    suspend fun stopAgent(taskId: String): Frame =
        request("agent.stop", buildJsonObject { put("taskId", taskId) })

    // ── 语义化封装:会话(多轮) ─────────────────────────────────────────────

    /**
     * 新建会话。返回 sessionId —— 之后所有轮次都复用它,agent 才会记得上文。
     * 服务端已把本连接自动订阅 `session:<sessionId>`,无需手动 sub。
     */
    suspend fun createSession(title: String? = null): String {
        val payload = buildJsonObject { title?.let { put("title", it) } }
        val res = request("session.create", payload)
        checkOk(res, "session.create")
        return res.data!!.jsonObject["sessionId"]!!.jsonPrimitive.content
    }

    /**
     * 在会话里发一条消息并等本轮结束。
     * 事件从 events 流以 push == "session:$sessionId" 到达。
     * 若上一轮之间 agent 被空闲回收,服务端会自动 resume 恢复上下文。
     */
    suspend fun sendMessage(sessionId: String, prompt: String, chunks: Boolean = false): Frame {
        val payload = buildJsonObject {
            put("sessionId", sessionId)
            put("prompt", prompt)
            put("chunks", chunks)
        }
        return request("session.send", payload, timeoutMs = 10 * 60_000)
    }

    /** 打断会话当前轮(保留会话与上下文)。 */
    suspend fun stopSession(sessionId: String): Frame =
        request("session.stop", buildJsonObject { put("sessionId", sessionId) })

    /** 会话消息历史(最新在后)。 */
    suspend fun sessionHistory(sessionId: String, limit: Int = 100): List<WireMessage> {
        val payload = buildJsonObject {
            put("sessionId", sessionId)
            put("limit", limit)
        }
        val res = request("session.history", payload)
        checkOk(res, "session.history")
        return res.data!!.jsonObject["messages"]!!.jsonArray.map { it.toWireMessage() }
    }

    /** 会话列表。includeDeleted=true 可看到软删的(宿主文件仍在)。 */
    suspend fun listSessions(
        limit: Int = 50,
        offset: Int = 0,
        includeDeleted: Boolean = false,
    ): List<SessionSummary> {
        val payload = buildJsonObject {
            put("limit", limit)
            put("offset", offset)
            put("includeDeleted", includeDeleted)
        }
        val res = request("session.list", payload)
        checkOk(res, "session.list")
        return res.data!!.jsonObject["sessions"]!!.jsonArray.map { it.toSessionSummary() }
    }

    /** 软删会话:只是从列表隐藏,宿主会话文件仍保留。 */
    suspend fun deleteSession(sessionId: String): Frame =
        request("session.delete", buildJsonObject { put("sessionId", sessionId) })

    private fun checkOk(res: Frame, op: String) {
        if (res.ok != true) error("$op 失败: ${res.code} ${res.message}")
    }

    /** 订阅推送码;wantAck=true 时等服务端 res ok 确认。 */
    suspend fun subscribe(pushCode: String, wantAck: Boolean = true) {
        if (!wantAck) { sendRaw(sub(add = listOf(pushCode))); return }
        val id = UUID.randomUUID().toString()
        val deferred = CompletableDeferred<Frame>()
        pending[id] = deferred
        try {
            sendRaw(sub(add = listOf(pushCode), id = id))
            withTimeout(5_000) { deferred.await() }
        } finally {
            pending.remove(id)
        }
    }

    suspend fun unsubscribe(pushCode: String) {
        sendRaw(sub(remove = listOf(pushCode)))
    }

    // ── 保活 ────────────────────────────────────────────────────────────────

    private fun startPing(ws: WebSocket) {
        pingJob?.cancel()
        pingJob = scope.launch {
            while (isActive) {
                delay(30_000)
                // WebSocket.ping() 由 OkHttp 处理控制帧;pong 由回调消费。
                // 若需应用级探活,这里改为 sendRaw(PING)。
                ws.send(json.encodeToString(PING))
            }
        }
    }

    private fun stopPing() { pingJob?.cancel(); pingJob = null }

    private fun failAllPending(t: Throwable) {
        pending.values.toList().forEach { it.completeExceptionally(t) }
        pending.clear()
    }
}
```

---

## 3. 消费事件

先按 `push` 分主题(哪个任务/会话),再按 `data.kind` 分类型:

```kotlin
scope.launch {
    client.events.collect { frame ->
        when (frame.kind) {
            "err" -> log("帧级错误 ${frame.code}: ${frame.message}")   // 不断连
            "evt" -> handleEvent(frame)
        }
    }
}

fun handleEvent(frame: Frame) {
    val data = frame.data?.jsonObject ?: return
    val push = frame.push ?: return
    // push 形如 "task:<taskId>" 或 "session:<sessionId>"
    when (data["kind"]?.jsonPrimitive?.content) {
        "agent.status"        -> setStatus(push, data["status"]?.jsonPrimitive?.content)
        "session.user-message" -> appendUserText(push, data["text"]?.jsonPrimitive?.content)  // 仅会话主题
        "assistant.message"   -> appendAssistantText(push, data["text"]?.jsonPrimitive?.content)
        "assistant.chunk"     -> appendChunk(push, data["chunk"])          // 仅 chunks=true
        "tool.call"           -> showTool(push, data["name"]?.jsonPrimitive?.content)
        "tool.result"         -> showToolResult(push, data["ok"]?.jsonPrimitive?.boolean)
        "agent.error"         -> showError(push, data["message"]?.jsonPrimitive?.content)
        else -> Unit                                                        // 未知 kind:忽略
    }
}
```

要点:

- **未知 `data.kind` 忽略**,服务端会新增事件类型。
- `session.user-message` 是会话内的用户输入回显 —— 自己发的那条也会收到,可用于多端同步(别把它当重复消息重复渲染,按需去重)。
- 一次 `session.send` 期间会收到多条 `evt`(状态、工具、若干 assistant 消息),最终以该请求的 `res` 收尾。

---

## 4. 最小可跑用例

### 4a. 一次性任务(无状态)

```kotlin
val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
val client = DshConnectClient("ws://192.168.1.10:8080", scope)

scope.launch {
    // 收集事件(自己发起的任务会自动收到,无需手动 sub)
    launch {
        client.events.collect { f ->
            if (f.kind == "evt") println("${f.push} -> ${f.data}")
        }
    }

    // 等连接建立
    client.state.first { it == DshConnectClient.ConnState.OPEN }

    val res = client.runAgent("读取项目 README 并总结")
    println("完成: ${res.data}")   // {taskId, sessionId, status, durationMs}
}

client.connect()
```

### 4b. 多轮对话(有状态 —— 记得上文)

```kotlin
scope.launch {
    client.state.first { it == DshConnectClient.ConnState.OPEN }

    // 1) 建会话,拿到 sessionId(之后每轮都复用它)
    val sessionId = client.createSession(title = "我的会话")

    // 2) 第一轮
    client.sendMessage(sessionId, "记住:我的代号是「蓝鲸七号」。")
    // agent 会记得

    // 3) 第二轮 —— 复用同一个 sessionId,上下文延续
    val res = client.sendMessage(sessionId, "我的代号是什么?")
    check(res.ok == true) { "${res.code}: ${res.message}" }

    // 4) 历史
    client.sessionHistory(sessionId).forEach { println("[${it.role}] ${it.text}") }

    // 5) 列表 / 软删
    client.listSessions().forEach { println("${it.sessionId} live=${it.live} ${it.title}") }
    client.deleteSession(sessionId)
}
```

**关键**:多轮必须复用 `sessionId`。服务端在 agent 被空闲回收后会自动 `resume` 恢复上下文,客户端无需做任何额外事——**只要别换 id**。

---

## 5. 实现检查表

**通用**

- [ ] `res` 按 `id` 派发,不假设返回顺序(并发请求)
- [ ] `evt` 先按 `push` 分主题,再按 `data.kind` 分类型;**未知 kind 忽略**
- [ ] 帧级 `err` 只上报,**不关连接**
- [ ] 发送前校验帧 < 256 KB
- [ ] `status:"failed"` 时不只依赖 `assistant.message`;注意 `error` 字段
- [ ] 明文流量/INTERNET 权限已配置(见 §0)

**一次性任务(`agent.run`)**

- [ ] 长任务超时单独放宽(默认 30s 不够)
- [ ] 重连后重新 `sub`(协议无客户端侧恢复语义)

**会话(`session.*`)**

- [ ] 多轮**复用同一个 `sessionId`** —— 换 id 就等于开新会话
- [ ] 不依赖 `session.create` 之外的订阅:创建者已自动订阅 `session:<id>`;观察**别人的**会话要显式 `sub`
- [ ] `session.send` 超时同样放宽(一轮可能几分钟)
- [ ] 处理 `session.user-message`(输入回显)时注意与自己乐观渲染去重
- [ ] 历史里过滤宿主注入的上下文消息(`<system-reminder>` 等)再渲染
- [ ] `session.delete` 是**软删**:不要向用户承诺"已彻底删除"(宿主文件仍在)
- [ ] `session.not.found` / `session.resume-failed` 要有兜底 UI(会话可能已被删或在宿主侧不可用)

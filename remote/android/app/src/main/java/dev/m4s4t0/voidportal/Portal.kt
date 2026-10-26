package dev.m4s4t0.voidportal

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * The phone's side of VOID Portal: one WebSocket to the relay, end-to-end encrypted calls to the PC,
 * live events, notifications, and PC presence (relay presence plus a heartbeat watchdog, so a PC that
 * loses power also shows as offline).
 */
object Portal {
    enum class Link { UNPAIRED, CONNECTING, CONNECTED, OFFLINE }
    enum class Pc { UNKNOWN, ONLINE, OFFLINE }

    val pairing = MutableStateFlow<Pairing?>(null)
    val link = MutableStateFlow(Link.UNPAIRED)
    val pc = MutableStateFlow(Pc.UNKNOWN)
    val lastError = MutableStateFlow<String?>(null)
    /** remote.state from the PC: settings, models, account status, projects. */
    val state = MutableStateFlow<JsonObject?>(null)
    val tasks = MutableStateFlow<List<JsonObject>>(emptyList())
    val approvals = MutableStateFlow<List<JsonObject>>(emptyList())
    /** Claude plan usage meters (5-hour, weekly, per model), kept current by plan.usage events. */
    val planUsage = MutableStateFlow<JsonObject?>(null)
    /** An admin restart in progress: {phase: "pending" | "restarting", taskId, install, reason}. */
    val adminRestart = MutableStateFlow<JsonObject?>(null)
    /** Live events (agent.*, queue.updated, …) for the screens. */
    val events = MutableSharedFlow<Pair<String, JsonObject>>(extraBufferCapacity = 512)
    /** The task open on screen right now; its "done" notification stays quiet. */
    @Volatile var visibleTask: String? = null

    private lateinit var app: Context
    private lateinit var store: PairingStore
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val client = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JsonElement>>()
    private var ws: WebSocket? = null
    private var retry = 0
    private var reconnectJob: Job? = null
    @Volatile private var lastHostFrame = 0L
    private var lastKnownPc: Pc? = null
    private var initialized = false

    private const val HEARTBEAT_TIMEOUT_MS = 75_000L
    private const val KEPT_SILENT_AFTER_MS = 10 * 60_000L

    fun init(context: Context) {
        if (initialized) return
        initialized = true
        app = context.applicationContext
        store = PairingStore(app)
        Notifier.ensureChannels(app)
        pairing.value = store.load()
        if (pairing.value != null) connect()
        scope.launch { watchdog() }
        PortalWidgetData.follow(app)
        val cm = app.getSystemService(ConnectivityManager::class.java)
        cm?.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                if (pairing.value != null && link.value != Link.CONNECTED) reconnectNow()
            }
        })
    }

    fun pair(p: Pairing) {
        store.save(p)
        pairing.value = p
        lastKnownPc = null
        reconnectNow()
        PortalService.start(app)
    }

    fun unpair() {
        store.clear()
        pairing.value = null
        disconnect()
        link.value = Link.UNPAIRED
        pc.value = Pc.UNKNOWN
        state.value = null
        tasks.value = emptyList()
        approvals.value = emptyList()
        planUsage.value = null
        LiveProgress.clear(app)
        PortalService.stop(app)
    }

    fun reconnectNow() {
        disconnect()
        retry = 0
        connect()
    }

    private fun disconnect() {
        reconnectJob?.cancel()
        reconnectJob = null
        ws?.close(1000, "bye")
        ws = null
    }

    private fun connect() {
        val p = pairing.value ?: return
        link.value = Link.CONNECTING
        val req = try {
            Request.Builder().url("${p.relayUrl}/v1/channel/${p.keys.channelId}?role=phone").header("Authorization", "Bearer ${p.keys.token}").build()
        } catch (e: IllegalArgumentException) {
            lastError.value = tr("Bad relay address: {url}", "url" to p.relayUrl)
            link.value = Link.OFFLINE
            return
        }
        lateinit var socket: WebSocket
        socket = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                if (ws !== socket) return
                retry = 0
                lastError.value = null
                link.value = Link.CONNECTED
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (ws === socket) onFrame(p, text)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped(socket, code, null)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
                dropped(socket, response?.code ?: 0, response?.let { tr("Relay answered {code}", "code" to it.code) } ?: t.message)
        })
        ws = socket
    }

    private fun dropped(socket: WebSocket, code: Int, error: String?) {
        if (ws !== socket) return
        ws = null
        for (d in pending.values) d.completeExceptionally(PortalError("offline", tr("The connection dropped.")))
        pending.clear()
        if (code == 4001) {
            // Removed on the PC: this pairing is gone for good.
            Notifier.show(app, Cue.ALERT, tr("Unpaired"), tr("This phone was removed in VOID Workshop on {pc}.", "pc" to (pairing.value?.pcName ?: tr("the PC"))), null)
            unpair()
            return
        }
        lastError.value = when (code) {
            403 -> tr("The relay refused this pairing. Pair again from the PC.")
            404 -> tr("The PC hasn't set up this pairing on the relay yet. Is VOID Workshop running?")
            else -> error
        }
        link.value = Link.OFFLINE
        val wait = minOf(30_000L, 1000L shl minOf(retry++, 5)) + (if (code == 403) 60_000L else 0L)
        reconnectJob = scope.launch {
            delay(wait)
            connect()
        }
    }

    private fun onFrame(p: Pairing, text: String) {
        val frame = try {
            Json.parseToJsonElement(text).jsonObject
        } catch (e: Exception) {
            return
        }
        when (frame.str("t")) {
            "peer" -> if (frame.str("role") == "host") setPc(frame.bool("online") == true)
            "msg" -> {
                val plain = try {
                    PortalCrypto.open(p.keys, "h2p", frame.str("d") ?: return)
                } catch (e: Exception) {
                    return // not sealed by our PC
                }
                lastHostFrame = System.currentTimeMillis()
                if (pc.value != Pc.ONLINE && frame.bool("kept") != true) setPc(true)
                val msg = try {
                    Json.parseToJsonElement(plain).jsonObject
                } catch (e: Exception) {
                    return
                }
                handle(msg, frame.bool("kept") == true)
            }
        }
    }

    private fun setPc(online: Boolean) {
        val now = if (online) Pc.ONLINE else Pc.OFFLINE
        if (online) lastHostFrame = System.currentTimeMillis()
        if (pc.value == now) return
        pc.value = now
        val prev = lastKnownPc
        lastKnownPc = now
        val name = pairing.value?.pcName ?: tr("PC")
        if (prev != null && prev != now) {
            if (online) Notifier.show(app, Cue.PC_ONLINE, tr("{name} is online", "name" to name), tr("VOID Workshop is reachable again."), null)
            else Notifier.show(app, Cue.PC_OFFLINE, tr("{name} went offline", "name" to name), tr("VOID Workshop stopped answering. Tasks pause until it is back."), null)
        }
        if (online) scope.launch { runCatching { refresh() } } else LiveProgress.clear(app)
    }

    /** A PC that loses power never says goodbye: treat a missing heartbeat as offline. */
    private suspend fun watchdog() {
        while (scope.isActive) {
            delay(10_000)
            if (link.value == Link.CONNECTED && pc.value == Pc.ONLINE && System.currentTimeMillis() - lastHostFrame > HEARTBEAT_TIMEOUT_MS) setPc(false)
        }
    }

    private fun handle(msg: JsonObject, kept: Boolean) {
        when (msg.str("type")) {
            "reply" -> {
                val d = pending.remove(msg.str("id") ?: return) ?: return
                if (msg.bool("ok") == true) d.complete(msg["result"] ?: JsonNull)
                else {
                    val e = msg.obj("error")
                    d.completeExceptionally(PortalError(e?.str("code") ?: "error", e?.str("message") ?: tr("The PC refused the request.")))
                }
            }
            "event" -> {
                val name = msg.str("event") ?: return
                val payload = msg.obj("payload") ?: JsonObject(emptyMap())
                applyEvent(name, payload)
                events.tryEmit(name to payload)
            }
            "notify" -> {
                val cue = when (msg.str("kind")) {
                    "done" -> Cue.DONE
                    "approval" -> Cue.APPROVAL
                    else -> Cue.ALERT
                }
                val taskId = msg.str("taskId")
                val old = kept && System.currentTimeMillis() - (msg.num("ts")?.toLong() ?: 0L) > KEPT_SILENT_AFTER_MS
                val watching = cue == Cue.DONE && taskId != null && taskId == visibleTask
                val approval = msg.obj("approval")
                if (approval != null && !old) Notifier.showApproval(app, approval)
                else Notifier.show(app, cue, msg.str("title") ?: "VOID Portal", msg.str("body") ?: "", taskId, silent = old || watching)
            }
        }
    }

    private fun applyEvent(name: String, p: JsonObject) {
        when (name) {
            "task.updated" -> {
                val id = p.str("id") ?: return
                val others = tasks.value.filter { it.str("id") != id }
                tasks.value = (listOf(p) + others).sortedByDescending { it.num("updated_at") ?: 0.0 }.take(40)
                LiveProgress.onTask(app, p)
            }
            "agent.tool" -> p.str("taskId")?.let { LiveProgress.onTool(app, it, p.str("summary")) }
            "agent.todos" -> p.str("taskId")?.let { LiveProgress.onTodos(app, it, p.arr("items")) }
            "plan.usage" -> planUsage.value = p
            // The PC's settings and admin session change from either side; keep the home and settings screens current.
            "settings.changed" -> patchState("settings", p)
            "admin.changed" -> {
                patchState("admin", p)
                if (p.bool("active") != true) adminRestart.value = null
            }
            "admin.restartPending" -> adminRestart.value = JsonObject(p + ("phase" to JsonPrimitive("pending")))
            "admin.restarting" -> adminRestart.value = JsonObject(p + ("phase" to JsonPrimitive("restarting")))
            "approval.request" -> approvals.value = approvals.value.filter { it.str("id") != p.str("id") } + p
            "approval.resolved" -> {
                approvals.value = approvals.value.filter { it.str("id") != p.str("id") }
                Notifier.cancelApproval(app, p.str("id"))
            }
        }
    }

    private fun patchState(key: String, value: JsonObject) {
        val s = state.value ?: return
        state.value = JsonObject(s + (key to value))
    }

    suspend fun call(method: String, params: JsonObject = JsonObject(emptyMap()), timeoutMs: Long = 60_000): JsonElement {
        val p = pairing.value ?: throw PortalError("unpaired", tr("Pair with VOID Workshop first."))
        val socket = ws
        if (link.value != Link.CONNECTED || socket == null) throw PortalError("offline", tr("No connection to the relay right now."))
        if (pc.value == Pc.OFFLINE) throw PortalError("pc-offline", tr("{name} is offline.", "name" to p.pcName))
        val id = UUID.randomUUID().toString()
        val reply = CompletableDeferred<JsonElement>()
        pending[id] = reply
        val body = buildJsonObject {
            put("type", "call")
            put("id", id)
            put("ts", System.currentTimeMillis())
            put("method", method)
            put("params", params)
        }
        val frame = buildJsonObject {
            put("t", "msg")
            put("d", PortalCrypto.seal(p.keys, "p2h", body.toString()))
        }
        if (!socket.send(frame.toString())) {
            pending.remove(id)
            throw PortalError("offline", tr("Could not send to the relay."))
        }
        try {
            return withTimeout(timeoutMs) { reply.await() }
        } catch (e: kotlinx.coroutines.TimeoutCancellationException) {
            throw PortalError("timeout", tr("The PC did not answer in time."))
        } finally {
            pending.remove(id)
        }
    }

    /** Reload the PC's state (home screen). */
    suspend fun refresh() {
        val s = call("remote.state") as? JsonObject ?: return
        state.value = s
        Themes.onPcState(s)
        // The short pairing code carries no PC name; learn it from the PC.
        val name = s.str("pc")?.take(60)
        val p = pairing.value
        if (name != null && p != null && p.pcName != name) {
            val renamed = p.copy(pcName = name)
            store.save(renamed)
            pairing.value = renamed
        }
        tasks.value = s.arr("tasks")
        LiveProgress.sync(app, tasks.value)
        approvals.value = s.arr("pendingApprovals")
        planUsage.value = s.obj("planUsage")
        // The PC answered after a restart: it is back.
        if (adminRestart.value?.str("phase") == "restarting") adminRestart.value = null
    }

    fun launch(block: suspend CoroutineScope.() -> Unit) = scope.launch(block = block)

    fun appContext(): Context = app
}

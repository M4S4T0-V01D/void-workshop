package dev.m4s4t0.voidportal.ui

import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.KeyboardDoubleArrowDown
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PlaylistAdd
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.m4s4t0.voidportal.Haptics
import dev.m4s4t0.voidportal.Portal
import dev.m4s4t0.voidportal.PortalError
import dev.m4s4t0.voidportal.UiSounds
import dev.m4s4t0.voidportal.arr
import dev.m4s4t0.voidportal.json
import dev.m4s4t0.voidportal.num
import dev.m4s4t0.voidportal.obj
import dev.m4s4t0.voidportal.str
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

val MODES = listOf("ask" to "Ask", "auto-edit" to "Edit auto", "auto" to "Auto", "plan" to "Plan")

/** Share sheets go through a Binder transaction (about 1 MB); longer exports are saved as a file instead. */
private const val SHARE_MAX_CHARS = 100_000

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskScreen(taskId: String, onBack: () -> Unit, onApproval: (String) -> Unit) {
    val timeline = remember(taskId) { Timeline() }
    var task by remember { mutableStateOf<JsonObject?>(null) }
    var queue by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var mode by remember { mutableStateOf("ask") }
    var context by remember { mutableStateOf<Pair<Double, Double>?>(null) }
    var draft by rememberSaveable(taskId) { mutableStateOf("") }
    var menu by remember { mutableStateOf(false) }
    var changes by remember { mutableStateOf(false) }
    val ctx = LocalContext.current
    val approvals by Portal.approvals.collectAsState()
    val pc by Portal.pc.collectAsState()
    val snack = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val list = rememberLazyListState()

    fun act(method: String, vararg params: Pair<String, Any?>, after: (() -> Unit)? = null) {
        scope.launch {
            try {
                Portal.call(method, json("taskId" to taskId, *params))
                after?.invoke()
            } catch (e: PortalError) {
                snack.showSnackbar(e.message ?: "Failed")
            }
        }
    }

    /** The exported Markdown waiting for the file picker, or for the share sheet. */
    var exported by remember { mutableStateOf<String?>(null) }
    val saveDoc = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("text/markdown")) { uri ->
        val md = exported ?: return@rememberLauncherForActivityResult
        exported = null
        if (uri == null) return@rememberLauncherForActivityResult
        scope.launch {
            val ok = withContext(Dispatchers.IO) {
                runCatching { ctx.contentResolver.openOutputStream(uri)?.use { it.write(md.toByteArray()) } != null }.getOrDefault(false)
            }
            snack.showSnackbar(if (ok) "Saved" else "Could not save the file")
        }
    }
    fun export(share: Boolean) {
        scope.launch {
            try {
                val md = (Portal.call("task.export", json("taskId" to taskId)) as JsonObject).str("markdown") ?: ""
                val name = (task?.str("title") ?: "task").replace(Regex("[^A-Za-z0-9 _-]"), "").trim().take(60).ifEmpty { "task" } + ".md"
                if (!share) {
                    exported = md
                    saveDoc.launch(name)
                } else if (md.length > SHARE_MAX_CHARS) {
                    snack.showSnackbar("Too long to share as text; use Save as Markdown")
                } else {
                    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_SUBJECT, name).putExtra(Intent.EXTRA_TEXT, md)
                    ctx.startActivity(Intent.createChooser(send, "Share task"))
                }
            } catch (e: PortalError) {
                snack.showSnackbar(if (e.code == "not-allowed") "Update VOID Workshop on the PC to export tasks" else e.message ?: "Export failed")
            }
        }
    }

    DisposableEffect(taskId) {
        Portal.visibleTask = taskId
        onDispose { if (Portal.visibleTask == taskId) Portal.visibleTask = null }
    }
    // Load (and reload after the PC comes back), then follow live events.
    LaunchedEffect(taskId, pc) {
        if (pc != Portal.Pc.ONLINE) return@LaunchedEffect
        try {
            val res = Portal.call("task.get", json("taskId" to taskId)) as JsonObject
            task = res.obj("task")
            queue = res.arr("queue")
            res.str("mode")?.let { mode = it } ?: run { if (task?.str("state") == "awaiting-plan-approval") mode = "plan" }
            res.obj("context")?.let { c -> context = (c.num("tokens") ?: 0.0) to (c.num("max") ?: 0.0) }
            timeline.clear()
            for (e in res.arr("events")) timeline.apply(e.str("kind") ?: continue, e.obj("payload") ?: JsonObject(emptyMap()))
        } catch (e: PortalError) {
            snack.showSnackbar(e.message ?: "Could not load the task")
        }
    }
    LaunchedEffect(taskId) {
        Portal.events.collect { (name, p) ->
            when {
                name == "task.updated" && p.str("id") == taskId -> task = p
                p.str("taskId") != taskId -> Unit
                name == "queue.updated" -> queue = p.arr("items")
                name == "agent.context" -> context = (p.num("tokens") ?: 0.0) to (p.num("max") ?: 0.0)
                name == "agent.mode" -> p.str("mode")?.let { mode = it }
                else -> timeline.apply(name, p)
            }
        }
    }
    // Follow new events only while at the bottom: dragging or jumping up stops it, reaching the bottom resumes it.
    var follow by remember(taskId) { mutableStateOf(true) }
    LaunchedEffect(list) {
        list.interactionSource.interactions.collect { if (it is DragInteraction.Start) follow = false }
    }
    LaunchedEffect(list) {
        snapshotFlow { list.canScrollForward }.collect { if (!it) follow = true }
    }
    val lastIndex = timeline.items.size + (if (timeline.streaming.isNotEmpty()) 1 else 0) - 1
    LaunchedEffect(timeline.items.size, timeline.streaming.length) {
        if (follow && lastIndex >= 0) list.animateScrollToItem(lastIndex)
    }
    // List positions of the messages, for the jump buttons; the streaming reply counts as one.
    val messages by remember(timeline) {
        derivedStateOf {
            timeline.items.indices.filter { timeline.items[it].isMessage() } +
                (if (timeline.streaming.isNotEmpty()) listOf(timeline.items.size) else emptyList())
        }
    }
    fun jump(to: Int?) {
        if (to == null) return
        follow = false
        Haptics.tick(ctx)
        scope.launch { list.animateScrollToItem(to) }
    }

    val state = task?.str("state")
    val running = state in RUNNING_STATES
    val mine = approvals.filter { it.str("taskId") == taskId }

    Scaffold(
        containerColor = Color.Transparent,
        snackbarHost = { SnackbarHost(snack) },
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                title = {
                    Column {
                        Text(task?.str("title") ?: "Task", maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 17.sp)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            StateBadge(state)
                            Spacer(Modifier.width(6.dp))
                            Text(projectName(task?.str("project")), color = Void.dim, fontSize = 12.sp)
                        }
                    }
                },
                actions = {
                    if (running) IconButton(onClick = { act("task.cancel") }) { Icon(Icons.Default.Stop, "Stop", tint = Void.bad) }
                    Box {
                        IconButton(onClick = { menu = true }) { Icon(Icons.Default.MoreVert, "More") }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(text = { Text("Changes and commit") }, onClick = { menu = false; changes = true })
                            DropdownMenuItem(text = { Text("Compact conversation") }, enabled = !running, onClick = { menu = false; act("task.compact") })
                            DropdownMenuItem(text = { Text("Finish task") }, enabled = !running, onClick = { menu = false; act("task.finish") })
                            DropdownMenuItem(text = { Text("Save as Markdown") }, onClick = { menu = false; export(share = false) })
                            DropdownMenuItem(text = { Text("Share as text") }, onClick = { menu = false; export(share = true) })
                        }
                    }
                },
            )
        },
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad).imePadding()) {
            Box(Modifier.weight(1f).fillMaxWidth()) {
                LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(timeline.items, key = { it.key }) { TimelineRow(it, taskId, running) }
                    if (timeline.streaming.isNotEmpty()) item { Bubble("Agent", timeline.streaming, mine = false) }
                }
                if (list.canScrollBackward || list.canScrollForward) {
                    val up = jumpUp(messages, list.firstVisibleItemIndex, list.firstVisibleItemScrollOffset)
                    val down = jumpDown(messages, list.firstVisibleItemIndex)
                    Column(Modifier.align(Alignment.BottomEnd).padding(end = 8.dp, bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        JumpButton(Icons.Default.KeyboardArrowUp, "Previous message", up != null) { jump(up) }
                        JumpButton(Icons.Default.KeyboardArrowDown, "Next message", down != null) { jump(down) }
                        JumpButton(Icons.Default.KeyboardDoubleArrowDown, "Jump to the bottom", list.canScrollForward) {
                            Haptics.tick(ctx)
                            follow = true
                            scope.launch { if (lastIndex >= 0) list.animateScrollToItem(lastIndex) }
                        }
                    }
                }
            }
            for (a in mine) {
                Card(Modifier.padding(horizontal = 12.dp, vertical = 4.dp).clickable { a.str("id")?.let(onApproval) }) {
                    Text("Needs you: ${a.str("summary") ?: ""}", fontWeight = FontWeight.SemiBold, color = Void.violet)
                    Text("Tap to review", color = Void.dim, fontSize = 12.sp)
                }
            }
            if (state == "awaiting-plan-approval") {
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for ((m, label) in listOf("ask" to "Approve", "auto-edit" to "Edit auto", "auto" to "Auto")) {
                        OutlinedButton(onClick = { Haptics.confirm(ctx); mode = m; act("task.approvePlan", "mode" to m) }, modifier = Modifier.weight(1f)) { Text(label, fontSize = 13.sp, maxLines = 1) }
                    }
                }
            }
            if (queue.isNotEmpty()) QueueList(queue, running, { id -> act("task.queue.sendNow", "id" to id) }, { id -> act("task.queue.remove", "id" to id) })
            Composer(
                draft = draft,
                onDraft = { draft = it },
                mode = mode,
                onMode = { m -> mode = m; act("task.setMode", "mode" to m) },
                running = running,
                context = context,
                onSend = {
                    val text = draft.trim()
                    if (text.isNotEmpty()) {
                        draft = ""
                        // While the agent works the PC queues the message; the sound says which happened.
                        UiSounds.play(if (running) UiSounds.Kind.QUEUE else UiSounds.Kind.SEND)
                        Haptics.confirm(ctx)
                        act("task.send", "text" to text, "mode" to mode)
                    }
                },
            )
        }
    }
    if (changes) {
        ChangesSheet(taskId, task?.str("title"), running, onClose = { changes = false }, onAskPush = {
            UiSounds.play(if (running) UiSounds.Kind.QUEUE else UiSounds.Kind.SEND)
            act("task.send", "text" to PUSH_REQUEST)
        })
    }
}

/** Sent by "Ask the agent to push": pushing goes through the agent, so the publish approval still applies. */
const val PUSH_REQUEST = "I committed your changes from my phone. Please push the current branch to its remote (only push, no other changes)."

@Composable
private fun TimelineRow(item: TItem, taskId: String, running: Boolean) {
    when (item) {
        is TImage -> ImageRow(taskId, item)
        is TUser -> Bubble("You", item.text, mine = true)
        is TAgent -> Bubble("Agent", item.text, mine = false)
        is TPlan -> Card { Text("Proposed plan", color = Void.violet, fontWeight = FontWeight.SemiBold); Text(item.text, fontSize = 14.sp) }
        is TNotice -> Text(item.text, color = when (item.level) { "error" -> Void.bad; "warn" -> Void.warn; else -> Void.dim }, fontSize = 13.sp, modifier = Modifier.padding(horizontal = 4.dp))
        is TTool -> {
            var open by remember { mutableStateOf(false) }
            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Void.panel).clickable { open = !open }.padding(8.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Dot(when (item.status) { "ok" -> Void.ok; "error" -> Void.bad; else -> Void.cyan }, pulse = running && item.status == "running")
                    Spacer(Modifier.width(8.dp))
                    Text(item.summary, fontSize = 13.sp, fontFamily = FontFamily.Monospace, maxLines = if (open) 6 else 1, overflow = TextOverflow.Ellipsis)
                }
                if (open && item.result != null) {
                    Text(item.result.take(4000), fontSize = 12.sp, fontFamily = FontFamily.Monospace, color = Void.dim, modifier = Modifier.padding(top = 6.dp).horizontalScroll(rememberScrollState()))
                }
            }
        }
    }
}

@Composable
private fun Bubble(who: String, text: String, mine: Boolean) {
    Column(Modifier.fillMaxWidth(), horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
        Text(who, color = Void.dim, fontSize = 11.sp)
        Text(
            text,
            fontSize = 15.sp,
            modifier = Modifier
                .clip(RoundedCornerShape(12.dp))
                .background(if (mine) Void.violet.copy(alpha = 0.22f) else Void.panel)
                .padding(10.dp),
        )
    }
}

/** A small round button over the conversation; dimmed when there is nowhere to go. */
@Composable
private fun JumpButton(icon: ImageVector, label: String, enabled: Boolean, onClick: () -> Unit) {
    Box(
        Modifier
            .size(36.dp)
            .clip(CircleShape)
            .background(Void.panelAlt.copy(alpha = 0.92f))
            .border(1.dp, Void.border, CircleShape)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, label, tint = if (enabled) Void.text else Void.dim.copy(alpha = 0.4f), modifier = Modifier.size(22.dp))
    }
}

@Composable
private fun QueueList(queue: List<JsonObject>, running: Boolean, sendNow: (String) -> Unit, remove: (String) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp).clip(RoundedCornerShape(10.dp)).background(Void.panelAlt).padding(8.dp)) {
        Text("${queue.size} queued · ${if (running) "sent when the agent finishes" else "paused"}", color = Void.dim, fontSize = 12.sp)
        for (q in queue) {
            val id = q.str("id") ?: continue
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(q.str("text") ?: "", Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, fontSize = 14.sp)
                IconButton(onClick = { sendNow(id) }) { Icon(Icons.Default.Bolt, "Send now", tint = Void.warn) }
                IconButton(onClick = { remove(id) }) { Icon(Icons.Default.Close, "Remove") }
            }
        }
    }
}

@Composable
private fun Composer(
    draft: String,
    onDraft: (String) -> Unit,
    mode: String,
    onMode: (String) -> Unit,
    running: Boolean,
    context: Pair<Double, Double>?,
    onSend: () -> Unit,
) {
    Column(Modifier.fillMaxWidth().background(Void.panel).padding(10.dp)) {
        Row(Modifier.horizontalScroll(rememberScrollState()), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for ((m, label) in MODES) FilterChip(selected = mode == m, onClick = { onMode(m) }, label = { Text(label, fontSize = 12.sp) })
            context?.takeIf { it.second > 0 }?.let { (used, max) ->
                Text("${formatTokens(used)} / ${formatTokens(max)}", color = if (used / max > 0.8) Void.warn else Void.dim, fontSize = 12.sp)
            }
        }
        SnippetChips(current = draft) { s -> onDraft(if (draft.isBlank()) s else "${draft.trimEnd()}\n\n$s") }
        Spacer(Modifier.height(6.dp))
        Row(verticalAlignment = Alignment.Bottom) {
            OutlinedTextField(
                value = draft,
                onValueChange = onDraft,
                modifier = Modifier.weight(1f),
                placeholder = { Text(if (running) "Queue a message…" else "Reply or ask for something else…") },
                maxLines = 6,
            )
            Spacer(Modifier.width(6.dp))
            Button(onClick = onSend, enabled = draft.isNotBlank(), contentPadding = PaddingValues(12.dp)) {
                Icon(if (running) Icons.Default.PlaylistAdd else Icons.AutoMirrored.Filled.Send, if (running) "Queue" else "Send")
            }
        }
    }
}

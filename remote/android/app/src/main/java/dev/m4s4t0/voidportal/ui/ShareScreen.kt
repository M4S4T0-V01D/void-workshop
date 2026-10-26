package dev.m4s4t0.voidportal.ui

import android.graphics.Bitmap
import android.net.Uri
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.m4s4t0.voidportal.Haptics
import dev.m4s4t0.voidportal.Portal
import dev.m4s4t0.voidportal.PortalError
import dev.m4s4t0.voidportal.SharedImages
import dev.m4s4t0.voidportal.UiSounds
import dev.m4s4t0.voidportal.arr
import dev.m4s4t0.voidportal.json
import dev.m4s4t0.voidportal.obj
import dev.m4s4t0.voidportal.str
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import dev.m4s4t0.voidportal.tr

/** Text and pictures shared from another app: start a task with them, or add them to one that is going. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ShareScreen(text: String, uris: List<Uri>, onCancel: () -> Unit, onSent: (String) -> Unit) {
    val ctx = LocalContext.current
    val state by Portal.state.collectAsState()
    val tasks by Portal.tasks.collectAsState()
    val pc by Portal.pc.collectAsState()
    val projects = state?.arr("projects") ?: emptyList()
    val active = tasks.filter { it.str("state") in ACTIVE_STATES }
    val pictures = remember(uris) { mutableStateListOf(*uris.take(SharedImages.MAX_PICTURES).toTypedArray()) }
    var message by rememberSaveable { mutableStateOf(text) }
    var newTask by rememberSaveable { mutableStateOf(true) }
    var root by rememberSaveable { mutableStateOf<String?>(null) }
    var taskId by rememberSaveable { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    val snack = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    if (root == null) root = projects.firstOrNull()?.str("path")
    if (taskId == null) taskId = active.firstOrNull()?.str("id")

    val ready = busy == null && pc == Portal.Pc.ONLINE && (message.isNotBlank() || pictures.isNotEmpty()) && (if (newTask) root != null else taskId != null)

    fun send() {
        scope.launch {
            try {
                val ids = mutableListOf<String>()
                for ((i, uri) in pictures.withIndex()) {
                    busy = tr("Sending picture {n} of {total}…", "n" to i + 1, "total" to pictures.size)
                    ids += SharedImages.upload(ctx, uri)
                }
                busy = tr("Sending…")
                val words = message.trim().ifEmpty { if (ids.size == 1) tr("Look at this picture.") else tr("Look at these pictures.") }
                val imageIds = JsonArray(ids.map(::JsonPrimitive)).takeIf { ids.isNotEmpty() }
                val id = if (newTask) {
                    val mode = state?.obj("settings")?.str("agentMode") ?: "ask"
                    (Portal.call("task.start", json("root" to root, "prompt" to words, "mode" to mode, "imageIds" to imageIds)) as JsonObject).str("id")
                } else {
                    Portal.call("task.send", json("taskId" to taskId, "text" to words, "imageIds" to imageIds))
                    taskId
                }
                Haptics.confirm(ctx)
                UiSounds.play(if (newTask) UiSounds.Kind.NEW_TASK else UiSounds.Kind.SEND)
                id?.let(onSent) ?: onCancel()
            } catch (e: PortalError) {
                Haptics.reject(ctx)
                snack.showSnackbar(e.message ?: tr("Could not send it"))
            } finally {
                busy = null
            }
        }
    }

    Scaffold(
        containerColor = Color.Transparent,
        snackbarHost = { SnackbarHost(snack) },
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                navigationIcon = { IconButton(onClick = onCancel) { Icon(Icons.Default.Close, tr("Cancel")) } },
                title = { Text(tr("Send to the PC")) },
            )
        },
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad).padding(16.dp).imePadding().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (pc != Portal.Pc.ONLINE) Text(tr("The PC is offline. It can be sent once VOID Workshop is reachable."), color = Void.warn, fontSize = 13.sp)
            if (pictures.isNotEmpty()) {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (uri in pictures.toList()) Thumbnail(uri) { pictures.remove(uri) }
                }
                if (uris.size > SharedImages.MAX_PICTURES) Text(tr("Only the first {n} pictures go with one message.", "n" to SharedImages.MAX_PICTURES), color = Void.dim, fontSize = 12.sp)
            }
            OutlinedTextField(
                value = message,
                onValueChange = { message = it },
                modifier = Modifier.fillMaxWidth(),
                minLines = 3,
                placeholder = { Text(tr("What should the agent do with it?")) },
            )
            SnippetChips { message = if (message.isBlank()) it else "${message.trimEnd()}\n\n$it" }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                FilterChip(selected = newTask, onClick = { newTask = true }, label = { Text(tr("New task")) })
                FilterChip(selected = !newTask, onClick = { newTask = false }, enabled = active.isNotEmpty(), label = { Text(tr("Add to a task ({n})", "n" to active.size)) })
            }
            if (newTask) {
                if (projects.isEmpty()) Text(tr("Open a project in VOID Workshop on the PC first."), color = Void.dim)
                for (p in projects) {
                    val path = p.str("path") ?: continue
                    Choice(p.str("name") ?: projectName(path), path, root == path) { root = path }
                }
            } else {
                for (t in active) {
                    val id = t.str("id") ?: continue
                    Choice(t.str("title") ?: tr("Task"), projectName(t.str("project")), taskId == id) { taskId = id }
                }
            }
            Button(onClick = ::send, enabled = ready, modifier = Modifier.fillMaxWidth().height(50.dp)) {
                Text(busy ?: if (newTask) tr("Start on the PC") else tr("Send to the task"))
            }
        }
    }
}

@Composable
private fun Choice(title: String, sub: String, selected: Boolean, onClick: () -> Unit) {
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(if (selected) Void.violet.copy(alpha = 0.2f) else Void.panel).clickable(onClick = onClick).padding(12.dp),
    ) {
        Text(title, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(sub, color = Void.dim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun Thumbnail(uri: Uri, onRemove: () -> Unit) {
    val ctx = LocalContext.current
    var bmp by remember(uri) { mutableStateOf<Bitmap?>(null) }
    LaunchedEffect(uri) { bmp = SharedImages.thumbnail(ctx, uri) }
    Box(Modifier.size(96.dp).clip(RoundedCornerShape(10.dp)).background(Void.panel)) {
        bmp?.let { Image(it.asImageBitmap(), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
            ?: Text("…", color = Void.dim, modifier = Modifier.padding(8.dp))
        IconButton(onClick = onRemove, modifier = Modifier.size(32.dp).align(androidx.compose.ui.Alignment.TopEnd)) {
            Icon(Icons.Default.Close, tr("Remove"), tint = Color.White, modifier = Modifier.clip(RoundedCornerShape(50)).background(Color.Black.copy(alpha = 0.5f)).padding(2.dp))
        }
    }
}

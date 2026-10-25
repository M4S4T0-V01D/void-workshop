package dev.m4s4t0.voidportal.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
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
import dev.m4s4t0.voidportal.bool
import dev.m4s4t0.voidportal.json
import dev.m4s4t0.voidportal.str
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Files in these states are on disk and not committed yet. */
val COMMITTABLE = setOf("applied", "accepted", "tested")

/** The first line of a commit message from a task title: one line, no trailing dot, at most 72 characters. */
fun commitMessageFrom(title: String?): String {
    val line = title?.lineSequence()?.firstOrNull()?.trim()?.trimEnd('.')?.takeIf { it.isNotEmpty() } ?: return ""
    return if (line.length <= 72) line else line.take(71).trimEnd() + "…"
}

/**
 * What the task changed, with diffs: pick files, write a message, commit them on the PC (review.commit). Pushing stays
 * with the agent, so it goes through the usual publish approval.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChangesSheet(taskId: String, title: String?, running: Boolean, onClose: () -> Unit, onAskPush: () -> Unit) {
    val ctx = LocalContext.current
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var files by remember { mutableStateOf<List<JsonObject>?>(null) }
    val picked = remember { mutableStateListOf<String>() }
    var open by remember { mutableStateOf<String?>(null) }
    var message by remember { mutableStateOf(commitMessageFrom(title)) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var committed by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()

    suspend fun load() {
        try {
            val list = (Portal.call("review.list", json("taskId" to taskId)) as? JsonArray)?.filterIsInstance<JsonObject>() ?: emptyList()
            files = list
            picked.clear()
            picked.addAll(list.filter { it.str("status") in COMMITTABLE }.mapNotNull { it.str("rel") })
        } catch (e: PortalError) {
            error = e.message
            files = emptyList()
        }
    }
    LaunchedEffect(taskId) { load() }

    ModalBottomSheet(onDismissRequest = onClose, sheetState = sheet, containerColor = Void.panel) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Changes", fontSize = 20.sp, fontWeight = FontWeight.SemiBold)
            val list = files
            when {
                list == null -> Text("Loading…", color = Void.dim)
                list.isEmpty() -> Text("This task has not changed any files.", color = Void.dim)
                else -> LazyColumn(Modifier.fillMaxWidth().heightIn(max = 420.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    items(list, key = { it.str("rel") ?: "" }) { f -> FileRow(f, f.str("rel") in picked, open == f.str("rel"), onToggle = { on ->
                        val rel = f.str("rel") ?: return@FileRow
                        if (on) picked.add(rel) else picked.remove(rel)
                    }, onOpen = { open = if (open == f.str("rel")) null else f.str("rel") }) }
                }
            }
            committed?.let { sha ->
                Text("Committed ${sha.take(7)}. Nothing was pushed.", color = Void.ok, fontSize = 14.sp)
                OutlinedButton(onClick = { onAskPush(); onClose() }, modifier = Modifier.fillMaxWidth()) {
                    Text(if (running) "Queue: ask the agent to push" else "Ask the agent to push")
                }
                Text("The agent pushes after you approve it, like any publish step.", color = Void.dim, fontSize = 12.sp)
            }
            if (!list.isNullOrEmpty()) {
                OutlinedTextField(value = message, onValueChange = { message = it }, modifier = Modifier.fillMaxWidth(), label = { Text("Commit message") }, minLines = 2, maxLines = 6)
                Text("Prefilled from the task title.", color = Void.dim, fontSize = 12.sp)
                if (running) Text("The agent is still working; files may change after you commit.", color = Void.warn, fontSize = 12.sp)
                error?.let { Text(it, color = Void.bad, fontSize = 13.sp) }
                Button(
                    onClick = {
                        busy = true
                        error = null
                        scope.launch {
                            try {
                                val res = Portal.call("review.commit", json("taskId" to taskId, "paths" to JsonArray(picked.map(::JsonPrimitive)), "message" to message.trim())) as? JsonObject
                                committed = res?.str("sha") ?: "?"
                                Haptics.confirm(ctx)
                                load()
                            } catch (e: PortalError) {
                                Haptics.reject(ctx)
                                error = e.message
                            } finally {
                                busy = false
                            }
                        }
                    },
                    enabled = !busy && picked.isNotEmpty() && message.isNotBlank(),
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                ) { Text(if (busy) "Committing…" else "Commit ${picked.size} file${if (picked.size == 1) "" else "s"}") }
            }
            Text(" ", fontSize = 6.sp)
        }
    }
}

@Composable
private fun FileRow(f: JsonObject, checked: Boolean, open: Boolean, onToggle: (Boolean) -> Unit, onOpen: () -> Unit) {
    val status = f.str("status") ?: ""
    val can = status in COMMITTABLE
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Void.panelAlt)) {
        Row(Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(end = 10.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Checkbox(checked = checked && can, onCheckedChange = onToggle, enabled = can)
            Column(Modifier.weight(1f)) {
                Text(f.str("rel") ?: "", fontFamily = FontFamily.Monospace, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                val note = listOfNotNull(
                    if (f.bool("existed") == false) "new" else null,
                    status,
                    if (f.bool("externallyModified") == true) "edited outside the agent" else null,
                ).joinToString(" · ")
                Text(note, color = if (status == "committed") Void.ok else Void.dim, fontSize = 11.sp)
            }
        }
        if (open) {
            val diff = f.str("diff")
            if (diff == null) Text("No diff to show.", color = Void.dim, fontSize = 12.sp, modifier = Modifier.padding(10.dp))
            else DiffText(diff)
        }
    }
}

@Composable
private fun DiffText(diff: String) {
    val lines = diff.lineSequence().take(400).toList()
    Column(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(8.dp)) {
        for (l in lines) {
            val color = when {
                l.startsWith("+++") || l.startsWith("---") -> Void.dim
                l.startsWith("+") -> Void.ok
                l.startsWith("-") -> Void.bad
                l.startsWith("@@") -> Void.cyan
                else -> Void.text
            }
            Text(l, color = color, fontFamily = FontFamily.Monospace, fontSize = 11.sp, softWrap = false)
        }
        if (diff.lineSequence().count() > lines.size) Text("… more on the PC", color = Void.dim, fontSize = 11.sp)
    }
}

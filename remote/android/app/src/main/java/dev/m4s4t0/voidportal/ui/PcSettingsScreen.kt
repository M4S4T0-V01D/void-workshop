package dev.m4s4t0.voidportal.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.LockOpen
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
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.m4s4t0.voidportal.Portal
import dev.m4s4t0.voidportal.PortalError
import dev.m4s4t0.voidportal.arr
import dev.m4s4t0.voidportal.bool
import dev.m4s4t0.voidportal.json
import dev.m4s4t0.voidportal.num
import dev.m4s4t0.voidportal.obj
import dev.m4s4t0.voidportal.paletteFromJson
import dev.m4s4t0.voidportal.str
import dev.m4s4t0.voidportal.strs
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

private val CACHE_TTLS = listOf("auto" to "Default", "5m" to "5 minutes", "1h" to "1 hour")

/** A safety switch waiting for the admin password before it is sent. */
private data class PendingSafety(val key: String, val value: Boolean, val label: String)

/**
 * The desktop's Settings, from the phone: agent behaviour, speed and tokens, limits, commands, safety and the
 * desktop itself. Safety switches need the admin password unless an admin session is running.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PcSettingsScreen(onBack: () -> Unit) {
    val state by Portal.state.collectAsState()
    val snack = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    var pendingSafety by remember { mutableStateOf<PendingSafety?>(null) }
    LaunchedEffect(Unit) { runCatching { Portal.refresh() } }

    /** Change settings on the PC, then reload what the screens show. */
    fun update(vararg patch: Pair<String, Any?>) {
        scope.launch {
            try {
                Portal.call("settings.update", json(*patch))
                Portal.refresh()
            } catch (e: PortalError) {
                snack.showSnackbar(e.message ?: "The PC refused the change")
            }
        }
    }

    Scaffold(
        containerColor = Color.Transparent,
        snackbarHost = { SnackbarHost(snack) },
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                title = { Text("PC settings") },
            )
        },
    ) { pad ->
        val s = state?.obj("settings")
        if (s == null) {
            Box(Modifier.fillMaxSize().padding(pad).padding(24.dp)) { Text("Connect to the PC to change its settings.", color = Void.dim) }
            return@Scaffold
        }
        val admin = state?.obj("admin")
        // An older VOID Workshop sends only a few settings and drops changes to the rest: say so instead of showing blanks.
        if (admin == null) {
            Box(Modifier.fillMaxSize().padding(pad).padding(24.dp)) { Text(UPDATE_PC, color = Void.warn) }
            return@Scaffold
        }
        val adminActive = admin.bool("active") == true
        val sandbox = state?.obj("sandbox")
        fun safety(key: String, value: Boolean, label: String) {
            if (adminActive) update(key to value) else pendingSafety = PendingSafety(key, value, label)
        }
        LazyColumn(Modifier.fillMaxSize().padding(pad).imePadding(), contentPadding = PaddingValues(16.dp, 0.dp, 16.dp, 32.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item { SectionTitle("Agent") }
            item {
                Card {
                    Text("Mode for new sessions", fontWeight = FontWeight.Medium)
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for ((m, label) in MODES) FilterChip(selected = s.str("agentMode") == m, onClick = { update("agentMode" to m) }, label = { Text(label) })
                    }
                    SwitchRow("Git checkpoint before each task", "A private ref; branches, the index and your files stay as they are.", s.bool("checkpointBeforeTasks") == true) {
                        update("checkpointBeforeTasks" to it)
                    }
                }
            }

            item { SectionTitle("Speed & tokens") }
            item {
                Card {
                    // VOID Workshop 0.2.0 and newer.
                    if (s.containsKey("tokenSaver")) {
                        SwitchRow(
                            "Save tokens (recommended)",
                            "Compacts at 120k tokens at the latest, keeps less command output and asks for quiet commands and small screenshots.",
                            s.bool("tokenSaver") == true,
                        ) { update("tokenSaver" to it) }
                    }
                    if (s.containsKey("implementModel")) {
                        val models = state?.obj("models")?.arr(if (s.str("provider") == "ollama") "ollama" else "anthropic") ?: emptyList()
                        val chosen = s.str("implementModel")
                        var open by remember { mutableStateOf(false) }
                        Text("Implement approved plans with", fontWeight = FontWeight.Medium, fontSize = 14.sp)
                        Box {
                            OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) {
                                Text(
                                    if (chosen == null) "The same model" else models.firstOrNull { it.str("id") == chosen }?.str("displayName") ?: chosen,
                                    Modifier.weight(1f),
                                    maxLines = 1,
                                )
                                Icon(Icons.Default.ArrowDropDown, null)
                            }
                            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                                DropdownMenuItem(text = { Text("The same model") }, onClick = { open = false; update("implementModel" to null) })
                                for (m in models) {
                                    DropdownMenuItem(
                                        text = { Column { Text(m.str("displayName") ?: ""); Text(m.str("id") ?: "", color = Void.dim, fontSize = 11.sp) } },
                                        onClick = { open = false; update("implementModel" to m.str("id")) },
                                    )
                                }
                            }
                        }
                        Text("Plan with a strong model, build with a cheaper one: Sonnet uses far less of a Claude plan's weekly allowance.", color = Void.dim, fontSize = 12.sp)
                    }
                    OptionalNumberRow(
                        "Compact the conversation at (tokens)",
                        offLabel = "Use the model's own window",
                        value = s.num("contextCapTokens"),
                        min = 100_000.0,
                        max = 1_000_000.0,
                        defaultOn = 200_000.0,
                    ) { update("contextCapTokens" to it?.toLong()) }
                    Text("Prompt cache", fontWeight = FontWeight.Medium, fontSize = 14.sp)
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for ((id, label) in CACHE_TTLS) FilterChip(selected = s.str("promptCacheTtl") == id, onClick = { update("promptCacheTtl" to id) }, label = { Text(label) })
                    }
                    NumberRow("Max output tokens per reply", s.num("maxOutputTokens"), 1024.0, 128_000.0) { update("maxOutputTokens" to it.toLong()) }
                    SwitchRow("Fast mode", "Faster output at a higher price (extra usage on a Claude plan).", s.bool("fastMode") == true) { update("fastMode" to it) }
                    SwitchRow("Send queued messages together", "One request when the turn ends instead of several.", s.bool("sendQueuedTogether") == true) {
                        update("sendQueuedTogether" to it)
                    }
                }
            }

            item { SectionTitle("Limits") }
            item {
                Card {
                    NumberRow("Budget per task (USD)", s.num("perTaskBudgetUsd"), 0.01, 100.0, decimals = 2) { update("perTaskBudgetUsd" to it) }
                    NumberRow("Daily budget (USD)", s.num("dailyBudgetUsd"), 0.01, 500.0, decimals = 2) { update("dailyBudgetUsd" to it) }
                    OptionalNumberRow(
                        "Ask before tasks with a budget from (USD)",
                        offLabel = "Never ask",
                        value = s.num("confirmTaskBudgetAboveUsd"),
                        min = 0.0,
                        max = 100.0,
                        defaultOn = 2.0,
                        decimals = 2,
                    ) { update("confirmTaskBudgetAboveUsd" to it) }
                    Text("The USD budgets cap API-key spending; Claude plan and Ollama tasks don't use them.", color = Void.dim, fontSize = 12.sp)
                    NumberRow("Turns per run", s.num("maxTurns"), 1.0, 1000.0) { update("maxTurns" to it.toLong()) }
                    NumberRow("Tasks working at the same time", s.num("maxRunningTasks"), 1.0, 8.0) { update("maxRunningTasks" to it.toLong()) }
                }
            }

            item { SectionTitle("Commands") }
            item {
                Card {
                    NumberRow("Command timeout (seconds)", s.num("commandTimeoutSec"), 5.0, 3600.0) { update("commandTimeoutSec" to it.toLong()) }
                    NumberRow("Command output limit (KB)", s.num("commandOutputLimitKb"), 16.0, 4096.0) { update("commandOutputLimitKb" to it.toLong()) }
                }
            }

            item {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    SectionTitle("Safety")
                    Icon(if (adminActive) Icons.Default.LockOpen else Icons.Default.Lock, null, tint = if (adminActive) Void.warn else Void.dim, modifier = Modifier.padding(top = 6.dp).size(14.dp))
                }
            }
            item {
                Card {
                    Text(
                        if (adminActive) "Unlocked by the admin session." else if (admin?.bool("passwordSet") == true) "Needs your admin password." else "Set an admin password on the PC first (Settings → Admin).",
                        color = if (adminActive) Void.warn else Void.dim,
                        fontSize = 12.sp,
                    )
                    val full = s.bool("fullAccess") == true
                    SwitchRow(
                        "Full access (like Claude Code)",
                        "No sandbox: builds, installs, other repos and the network just work. Risky commands still ask; keys stay blocked.",
                        full,
                    ) { safety("fullAccess", it, "Full access") }
                    if (full) {
                        SwitchRow("Auto also pushes and publishes", "git push, gh, wrangler and release scripts run without asking in Auto.", s.bool("autoPublish") == true) {
                            safety("autoPublish", it, "Auto publishing")
                        }
                    }
                    val sandboxOk = sandbox?.bool("available") != false
                    SwitchRow(
                        "Sandbox agent commands",
                        if (sandboxOk) "Writes only inside the project, no network unless allowed. Ignored with full access."
                        else "Not available on the PC (missing: ${sandbox?.strs("missing")?.joinToString(", ")}).",
                        s.bool("sandboxCommands") == true,
                        enabled = sandboxOk,
                    ) { safety("sandboxCommands", it, "The sandbox") }
                    SwitchRow("Gradle / Android builds", "Sandboxed builds may write the Gradle caches and reach the Gradle, Maven and Google repositories.", s.bool("gradleBuilds") == true) {
                        safety("gradleBuilds", it, "Gradle builds")
                    }
                    SwitchRow("GitHub, push and release commands", "gh, git push, wrangler and release.sh become approvable; they always ask.", s.bool("allowPublishCommands") == true) {
                        safety("allowPublishCommands", it, "Publishing commands")
                    }
                }
            }

            item { SectionTitle("Desktop") }
            item {
                Card {
                    Text("Theme on the PC", fontWeight = FontWeight.Medium)
                    val themes = BUILTIN_THEMES.map { Triple(it.id, it.name.removeSuffix(" (default)"), it.accent) } +
                        (state?.arr("customThemes") ?: emptyList()).mapNotNull { t ->
                            t.str("id")?.let { Triple(it, t.str("name") ?: it, paletteFromJson(t)?.accent ?: Void.cyan) }
                        }
                    Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        for ((id, name, color) in themes) {
                            FilterChip(
                                selected = s.str("themeId") == id,
                                onClick = { update("themeId" to id) },
                                label = { Text(name) },
                                leadingIcon = { Box(Modifier.size(10.dp).clip(CircleShape).background(color)) },
                            )
                        }
                    }
                    SwitchRow("Keep running in the background", "Closing the window hides it to the tray, so VOID Portal keeps working.", s.bool("runInBackground") == true) {
                        update("runInBackground" to it)
                    }
                    SwitchRow("Start at login", "Starts hidden in the tray when you log in.", s.bool("startAtLogin") == true) { update("startAtLogin" to it) }
                }
            }

            if (s.str("provider") == "ollama") {
                item { SectionTitle("Ollama") }
                item {
                    Card {
                        TextSettingRow("Server address", s.str("ollamaUrl") ?: "", "http://127.0.0.1:11434") { update("ollamaUrl" to it) }
                        Text("Must be on the PC itself (http://127.0.0.1:PORT or http://localhost:PORT).", color = Void.dim, fontSize = 12.sp)
                    }
                }
            }
        }
    }
    pendingSafety?.let { p ->
        AdminPasswordDialog(
            title = "${p.label}: turn ${if (p.value) "on" else "off"}?",
            text = "Safety settings on the PC need your admin password.",
            confirm = "Change",
            onDismiss = { pendingSafety = null },
        ) { pw ->
            Portal.call("settings.update", json(p.key to p.value, "adminPassword" to pw))
            runCatching { Portal.refresh() }
        }
    }
}

@Composable
private fun SwitchRow(title: String, hint: String?, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end = 10.dp)) {
            Text(title, fontSize = 14.sp, color = if (enabled) Void.text else Void.dim)
            hint?.let { Text(it, color = Void.dim, fontSize = 12.sp) }
        }
        Switch(checked = checked, onCheckedChange = onChange, enabled = enabled)
    }
}

private fun format(v: Double, decimals: Int): String = if (decimals == 0) v.toLong().toString() else "%.${decimals}f".format(v)

/** A number the PC keeps: edited as text, sent when done (keyboard Done or leaving the field), clamped to its range. */
@Composable
private fun NumberRow(label: String, value: Double?, min: Double, max: Double, decimals: Int = 0, onCommit: (Double) -> Unit) {
    val shown = value?.let { format(it, decimals) } ?: ""
    var text by remember(shown) { mutableStateOf(shown) }
    // Done also drops the focus: send once, not twice.
    var sent by remember(shown) { mutableStateOf<String?>(null) }
    val focus = LocalFocusManager.current
    fun commit() {
        val n = text.replace(',', '.').toDoubleOrNull() ?: return run { text = shown }
        val clamped = n.coerceIn(min, max).let { if (decimals == 0) Math.round(it).toDouble() else it }
        text = format(clamped, decimals)
        if (text == sent) return
        if (value == null || kotlin.math.abs(clamped - value) > 1e-9) {
            sent = text
            onCommit(clamped)
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f).padding(end = 10.dp)) {
            Text(label, fontSize = 14.sp)
            Text("${format(min, decimals)}–${format(max, decimals)}", color = Void.dim, fontSize = 11.sp)
        }
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            singleLine = true,
            modifier = Modifier.width(120.dp).onFocusChanged { if (!it.isFocused && text != shown) commit() },
            keyboardOptions = KeyboardOptions(keyboardType = if (decimals == 0) KeyboardType.Number else KeyboardType.Decimal, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = {
                commit()
                focus.clearFocus()
            }),
        )
    }
}

/** A number that can also be switched off (null on the PC). */
@Composable
private fun OptionalNumberRow(label: String, offLabel: String, value: Double?, min: Double, max: Double, defaultOn: Double, decimals: Int = 0, onCommit: (Double?) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SwitchRow(offLabel, null, value == null) { off -> onCommit(if (off) null else defaultOn) }
        if (value != null) NumberRow(label, value, min, max, decimals) { onCommit(it) }
    }
}

@Composable
private fun TextSettingRow(label: String, value: String, placeholder: String, onCommit: (String) -> Unit) {
    var text by remember(value) { mutableStateOf(value) }
    val focus = LocalFocusManager.current
    OutlinedTextField(
        value = text,
        onValueChange = { text = it },
        label = { Text(label) },
        placeholder = { Text(placeholder) },
        singleLine = true,
        modifier = Modifier.fillMaxWidth().onFocusChanged { if (!it.isFocused && text.trim() != value && text.isNotBlank()) onCommit(text.trim()) },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Done),
        keyboardActions = KeyboardActions(onDone = {
            if (text.trim() != value && text.isNotBlank()) onCommit(text.trim())
            focus.clearFocus()
        }),
    )
}

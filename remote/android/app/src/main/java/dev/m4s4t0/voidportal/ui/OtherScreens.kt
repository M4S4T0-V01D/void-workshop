package dev.m4s4t0.voidportal.ui

import android.content.Context
import android.content.Intent
import android.media.RingtoneManager
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.QrCodeScanner
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.IntentCompat
import dev.m4s4t0.voidportal.BuildConfig
import dev.m4s4t0.voidportal.Cue
import dev.m4s4t0.voidportal.Haptics
import dev.m4s4t0.voidportal.LiveProgress
import dev.m4s4t0.voidportal.Notifier
import dev.m4s4t0.voidportal.Pairing
import dev.m4s4t0.voidportal.Portal
import dev.m4s4t0.voidportal.Themes
import dev.m4s4t0.voidportal.PortalError
import dev.m4s4t0.voidportal.UiSounds
import dev.m4s4t0.voidportal.arr
import dev.m4s4t0.voidportal.json
import dev.m4s4t0.voidportal.obj
import dev.m4s4t0.voidportal.str
import dev.m4s4t0.voidportal.strs
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import dev.m4s4t0.voidportal.tr

// ---- Pairing ------------------------------------------------------------------------------------

@Composable
fun PairScreen(error: String?, onLink: (String) -> Unit) {
    var scanning by remember { mutableStateOf(false) }
    var paste by remember { mutableStateOf("") }
    if (scanning) {
        QrScanner(onResult = { code ->
            scanning = false
            onLink(code)
        }, onClose = { scanning = false })
        return
    }
    Column(
        Modifier.fillMaxSize().padding(24.dp).systemBarsPadding().verticalScroll(rememberScrollState()).imePadding(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        PortalLogo(Modifier.size(170.dp))
        Spacer(Modifier.height(16.dp))
        Text("VOID Portal", fontSize = 28.sp, fontWeight = FontWeight.SemiBold)
        Text(
            tr("Your remote for VOID Workshop. On the PC open Settings → VOID Portal (phone) → Pair a phone, then scan the code."),
            color = Void.dim,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(vertical = 12.dp),
        )
        Button(
            onClick = { scanning = true },
            modifier = Modifier.fillMaxWidth().height(52.dp),
        ) {
            Icon(Icons.Default.QrCodeScanner, null)
            Spacer(Modifier.size(8.dp))
            Text(tr("Scan pairing code"))
        }
        error?.let { Text(it, color = Void.bad, modifier = Modifier.padding(top = 10.dp), textAlign = TextAlign.Center) }
        Spacer(Modifier.height(28.dp))
        Text(tr("Or paste the pairing link"), color = Void.dim, fontSize = 13.sp)
        OutlinedTextField(value = paste, onValueChange = { paste = it }, singleLine = true, modifier = Modifier.fillMaxWidth(), placeholder = { Text("VOIDPORTAL://P/…") })
        TextButton(onClick = { onLink(paste) }, enabled = paste.isNotBlank()) { Text(tr("Pair")) }
    }
}

fun tryPair(link: String): String? = try {
    Portal.pair(Pairing.parse(link))
    null
} catch (e: IllegalArgumentException) {
    e.message ?: tr("That is not a VOID Portal pairing code.")
}

// ---- New task -----------------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewTaskScreen(onBack: () -> Unit, onStarted: (String) -> Unit) {
    val state by Portal.state.collectAsState()
    val projects = state?.arr("projects") ?: emptyList()
    var root by remember { mutableStateOf(projects.firstOrNull()?.str("path")) }
    var prompt by rememberSaveable { mutableStateOf("") }
    var mode by remember { mutableStateOf(state?.obj("settings")?.str("agentMode") ?: "ask") }
    var busy by remember { mutableStateOf(false) }
    val snack = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    Scaffold(
        containerColor = Color.Transparent,
        snackbarHost = { SnackbarHost(snack) },
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, tr("Back")) } },
                title = { Text(tr("New task")) },
            )
        },
    ) { pad ->
        Column(Modifier.fillMaxSize().padding(pad).padding(16.dp).imePadding().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            SectionTitle(tr("Project"))
            val folders = state?.arr("folders") ?: emptyList()
            if (projects.isEmpty() && folders.isEmpty()) Text(tr("Open a project in VOID Workshop on the PC first."), color = Void.dim)
            for (p in projects) {
                val path = p.str("path") ?: continue
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(if (root == path) Void.violet.copy(alpha = 0.2f) else Void.panel).clickable { root = path }.padding(12.dp),
                ) {
                    Column {
                        Text(p.str("name") ?: projectName(path), fontWeight = FontWeight.Medium)
                        Text(path, color = Void.dim, fontSize = 12.sp)
                    }
                }
            }
            // Every other folder next to those projects (the PC lists them): start a task in any of them.
            if (folders.isNotEmpty()) {
                var showAll by rememberSaveable { mutableStateOf(false) }
                var find by rememberSaveable { mutableStateOf("") }
                TextButton(onClick = { showAll = !showAll }) { Text(if (showAll) tr("Hide all projects") else tr("All projects ({n})", "n" to folders.size)) }
                if (showAll) {
                    OutlinedTextField(value = find, onValueChange = { find = it }, modifier = Modifier.fillMaxWidth(), singleLine = true, placeholder = { Text(tr("Find a project")) })
                    val shown = folders.filter { (it.str("name") ?: "").contains(find.trim(), ignoreCase = true) }.take(60)
                    for (f in shown) {
                        val path = f.str("path") ?: continue
                        Row(
                            Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(if (root == path) Void.violet.copy(alpha = 0.2f) else Void.panel).clickable { root = path }.padding(12.dp),
                        ) {
                            Column {
                                Text(f.str("name") ?: projectName(path), fontWeight = FontWeight.Medium)
                                Text(path, color = Void.dim, fontSize = 12.sp)
                            }
                        }
                    }
                }
            }
            SectionTitle(tr("What should it do?"))
            OutlinedTextField(value = prompt, onValueChange = { prompt = it }, modifier = Modifier.fillMaxWidth(), minLines = 4, placeholder = { Text(tr("e.g. Add input validation to the signup form and a test for it")) })
            SnippetChips(current = prompt) { s -> prompt = if (prompt.isBlank()) s else "${prompt.trimEnd()}\n\n$s" }
            SectionTitle(tr("Mode"))
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for ((m, label) in MODES) FilterChip(selected = mode == m, onClick = { mode = m }, label = { Text(label) })
            }
            Button(
                onClick = {
                    busy = true
                    scope.launch {
                        try {
                            val t = Portal.call("task.start", json("root" to root, "prompt" to prompt.trim(), "mode" to mode)) as JsonObject
                            UiSounds.play(UiSounds.Kind.NEW_TASK)
                            Haptics.confirm(ctx)
                            t.str("id")?.let(onStarted)
                        } catch (e: PortalError) {
                            snack.showSnackbar(e.message ?: tr("Could not start the task"))
                        } finally {
                            busy = false
                        }
                    }
                },
                enabled = !busy && root != null && prompt.isNotBlank(),
                modifier = Modifier.fillMaxWidth().height(50.dp),
            ) { Text(if (busy) tr("Starting…") else tr("Start on the PC")) }
        }
    }
}

// ---- Approvals ----------------------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ApprovalSheet(approvalId: String, onClose: () -> Unit) {
    val approvals by Portal.approvals.collectAsState()
    val a = approvals.firstOrNull { it.str("id") == approvalId }
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var note by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun respond(decision: String, always: Boolean = false, allowAll: Boolean = false) {
        scope.launch {
            try {
                Portal.call(
                    "approval.respond",
                    json(
                        "approvalId" to approvalId,
                        "decision" to decision,
                        "note" to note.ifBlank { null },
                        "always" to if (always) true else null,
                        "allowAll" to if (allowAll) true else null,
                    ),
                )
                Notifier.cancelApproval(Portal.appContext(), approvalId)
                if (decision == "allow") Haptics.confirm(Portal.appContext()) else Haptics.reject(Portal.appContext())
                onClose()
            } catch (e: PortalError) {
                Haptics.reject(Portal.appContext())
                error = e.message
            }
        }
    }
    ModalBottomSheet(onDismissRequest = onClose, sheetState = sheet, containerColor = Void.panel) {
        Column(Modifier.fillMaxWidth().padding(16.dp).navigationBarsPadding().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            if (a == null) {
                Text(tr("This request was already answered."), color = Void.dim)
                TextButton(onClick = onClose) { Text(tr("Close")) }
                return@Column
            }
            val kind = a.str("kind")
            Text(
                when (kind) {
                    "command" -> tr("Run a command?")
                    "file-change" -> if (a.str("isNew") == "true") tr("Create a file?") else tr("Change a file?")
                    else -> tr("Read a sensitive file?")
                },
                fontSize = 20.sp,
                fontWeight = FontWeight.SemiBold,
            )
            Text(a.str("summary") ?: "", color = Void.text)
            a.str("sensitive")?.let { Text(tr("Sensitive: {what}", "what" to it), color = Void.warn, fontSize = 13.sp) }
            if (kind == "command") {
                Code(a.str("command") ?: "")
                a.str("cwd")?.let { Text(tr("in {path}", "path" to it), color = Void.dim, fontSize = 12.sp) }
                a.obj("assessment")?.let { asm ->
                    if ("publishes" in asm.strs("categories")) {
                        Text(tr("Publishes for real (GitHub, git push or Cloudflare)"), color = Void.bad, fontWeight = FontWeight.SemiBold)
                    }
                    asm.strs("warnings").forEach { w -> Text("• $w", color = Void.warn, fontSize = 13.sp) }
                }
                Text(if (a.str("sandboxed") == "true") tr("Runs in the sandbox (project-only writes)") else tr("Runs without the sandbox"), color = Void.dim, fontSize = 12.sp)
            }
            if (kind == "file-change") {
                a.str("rel")?.let { Text(it, fontFamily = FontFamily.Monospace, color = Void.cyan) }
                a.str("diff")?.let { Diff(it) }
            }
            if (kind == "read") a.str("rel")?.let { Code(it) }
            OutlinedTextField(value = note, onValueChange = { note = it }, modifier = Modifier.fillMaxWidth(), placeholder = { Text(tr("Note to the agent (optional)")) })
            error?.let { Text(it, color = Void.bad) }
            if (kind == "command" && a.str("canAlwaysAllow") == "true") {
                OutlinedButton(onClick = { respond("allow", always = true) }, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                    Text(tr("Always allow this exact command"))
                }
            }
            if (a.str("canAllowAll") == "true") {
                OutlinedButton(onClick = { respond("allow", allowAll = true) }, modifier = Modifier.fillMaxWidth().height(48.dp)) {
                    Text(tr("Allow all · switch this task to Auto"))
                }
                Text(tr("Risky commands (publishing, force-push, sudo, outside the project) still ask; blocked ones stay blocked."), color = Void.dim, fontSize = 12.sp)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(onClick = { respond("deny") }, modifier = Modifier.weight(1f).height(48.dp)) { Text(tr("Deny")) }
                Button(onClick = { respond("allow") }, modifier = Modifier.weight(1f).height(48.dp)) {
                    Text(when (kind) { "command" -> tr("Run once"); "file-change" -> tr("Apply change"); else -> tr("Allow") })
                }
            }
        }
    }
}

@Composable
private fun Code(text: String) {
    SelectionContainer {
        Text(
            text,
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Void.bg).padding(10.dp).horizontalScroll(rememberScrollState()),
        )
    }
}

@Composable
private fun Diff(diff: String) {
    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Void.bg).padding(8.dp).horizontalScroll(rememberScrollState())) {
        for (line in diff.lines().take(600)) {
            val color = when {
                line.startsWith("+++") || line.startsWith("---") -> Void.dim
                line.startsWith("+") -> Void.ok
                line.startsWith("-") -> Void.bad
                line.startsWith("@@") -> Void.cyan
                else -> Void.text
            }
            Text(line, color = color, fontFamily = FontFamily.Monospace, fontSize = 12.sp, softWrap = false)
        }
    }
}

// ---- Settings -----------------------------------------------------------------------------------

private class PickSound : ActivityResultContract<Uri?, Uri?>() {
    override fun createIntent(context: Context, input: Uri?) = Intent(RingtoneManager.ACTION_RINGTONE_PICKER)
        .putExtra(RingtoneManager.EXTRA_RINGTONE_TYPE, RingtoneManager.TYPE_NOTIFICATION)
        .putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_SILENT, false)
        .putExtra(RingtoneManager.EXTRA_RINGTONE_SHOW_DEFAULT, true)
        .putExtra(RingtoneManager.EXTRA_RINGTONE_EXISTING_URI, input)

    override fun parseResult(resultCode: Int, intent: Intent?): Uri? =
        if (resultCode == android.app.Activity.RESULT_OK && intent != null) IntentCompat.getParcelableExtra(intent, RingtoneManager.EXTRA_RINGTONE_PICKED_URI, Uri::class.java) else null
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(onBack: () -> Unit, onPcSettings: () -> Unit) {
    val ctx = LocalContext.current
    val snack = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val pairing by Portal.pairing.collectAsState()
    var picking by remember { mutableStateOf<Cue?>(null) }
    var refresh by remember { mutableIntStateOf(0) }
    var confirmUnpair by remember { mutableStateOf(false) }
    val pick = rememberLauncherForActivityResult(PickSound()) { uri ->
        val cue = picking
        if (cue != null && uri != null) {
            Notifier.setSound(ctx, cue, uri)
            refresh++
        }
        picking = null
    }
    Scaffold(
        containerColor = Color.Transparent,
        snackbarHost = { SnackbarHost(snack) },
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, tr("Back")) } },
                title = { Text(tr("Settings")) },
            )
        },
    ) { pad ->
        LazyColumn(Modifier.fillMaxSize().padding(pad), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item { SectionTitle(tr("The PC")) }
            item {
                Card(Modifier.clickable(onClick = onPcSettings)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.Computer, null, tint = Void.cyan)
                        Spacer(Modifier.size(10.dp))
                        Column(Modifier.weight(1f)) {
                            Text(tr("PC settings"), fontWeight = FontWeight.Medium)
                            Text(tr("Mode, speed and tokens, limits, commands, safety, the desktop's theme"), color = Void.dim, fontSize = 13.sp)
                        }
                        Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, null, tint = Void.dim)
                    }
                }
            }
            item { AdminCard(onMessage = { m -> scope.launch { snack.showSnackbar(m) } }) }
            item { SectionTitle(tr("Theme")) }
            item { ThemePicker() }
            item { SectionTitle(tr("Language")) }
            item {
                Card {
                    LanguageChips()
                    Text(tr("The PC has its own setting: VOID Workshop → Settings → Appearance."), color = Void.dim, fontSize = 12.sp)
                }
            }
            item { SectionTitle(tr("Sounds")) }
            items(Cue.entries.toList()) { cue ->
                refresh.let { _ ->
                    Card {
                        Text(cue.label, fontWeight = FontWeight.Medium)
                        Text(if (Notifier.isCustom(ctx, cue)) tr("Your sound") else tr("VOID sound"), color = Void.dim, fontSize = 13.sp)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            IconButton(onClick = { Notifier.preview(ctx, cue) }) { Icon(Icons.Default.PlayArrow, tr("Play"), tint = Void.cyan) }
                            OutlinedButton(onClick = { picking = cue; pick.launch(Notifier.sound(ctx, cue)) }) { Text(tr("Change")) }
                            if (Notifier.isCustom(ctx, cue)) TextButton(onClick = { Notifier.setSound(ctx, cue, null); refresh++ }) { Text(tr("Use VOID sound")) }
                        }
                    }
                }
            }
            item {
                val on by UiSounds.enabled.collectAsState()
                Card {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(tr("Interface sounds"), fontWeight = FontWeight.Medium)
                            Text(tr("Send, queue and new task. Quiet when the phone is on silent."), color = Void.dim, fontSize = 13.sp)
                        }
                        Switch(checked = on, onCheckedChange = { UiSounds.setEnabled(ctx, it) })
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        for ((label, kind) in listOf(tr("Send") to UiSounds.Kind.SEND, tr("Queue") to UiSounds.Kind.QUEUE, tr("New task") to UiSounds.Kind.NEW_TASK)) {
                            TextButton(onClick = { UiSounds.play(kind) }) {
                                Icon(Icons.Default.PlayArrow, null, tint = Void.cyan)
                                Text(label)
                            }
                        }
                    }
                }
            }
            item {
                val on by Haptics.enabled.collectAsState()
                ToggleCard(tr("Haptics"), tr("A short tap when something is approved, denied, sent or committed."), on) { Haptics.setEnabled(ctx, it) }
            }
            item {
                val on by LiveProgress.enabled.collectAsState()
                ToggleCard(
                    tr("Live progress"),
                    tr("While a task runs: what it is doing, its to-do progress, Stop and Reply, in one quiet notification (a Live Update on Android 16)."),
                    on,
                ) { LiveProgress.setEnabled(ctx, it) }
            }
            item {
                Text(
                    tr("To use your own sound file, copy it into the phone's Notifications folder first; it then shows up under Change."),
                    color = Void.dim,
                    fontSize = 12.sp,
                )
            }
            item { SectionTitle(tr("Stay connected")) }
            item {
                Card {
                    val pm = ctx.getSystemService(PowerManager::class.java)
                    val exempt = pm?.isIgnoringBatteryOptimizations(ctx.packageName) == true
                    Text(if (exempt) tr("Battery optimisation is off for VOID Portal.") else tr("Android may pause VOID Portal to save battery, delaying notifications."))
                    if (!exempt) {
                        Button(onClick = {
                            ctx.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}")))
                        }) { Text(tr("Let it run in the background")) }
                    }
                    OutlinedButton(onClick = {
                        ctx.startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, ctx.packageName))
                    }) { Text(tr("Notification settings")) }
                }
            }
            item { SectionTitle(tr("Updates")) }
            item { UpdatesCard() }
            item { SectionTitle(tr("Pairing")) }
            item {
                Card {
                    Text(tr("Paired with {name}", "name" to (pairing?.pcName ?: "—")))
                    Text(pairing?.relayUrl ?: "", color = Void.dim, fontSize = 12.sp, fontFamily = FontFamily.Monospace)
                    Button(onClick = { confirmUnpair = true }, colors = ButtonDefaults.buttonColors(containerColor = Void.bad.copy(alpha = 0.85f))) { Text(tr("Unpair this phone")) }
                }
            }
            item { Text("VOID Portal ${BuildConfig.VERSION_NAME}", color = Void.dim, fontSize = 12.sp, modifier = Modifier.padding(top = 8.dp)) }
        }
    }
    if (confirmUnpair) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            title = { Text(tr("Unpair?")) },
            text = { Text(tr("This phone forgets the PC. Also remove it in VOID Workshop (Settings → VOID Portal) so the relay channel is deleted.")) },
            confirmButton = { TextButton(onClick = { confirmUnpair = false; Portal.unpair(); onBack() }) { Text(tr("Unpair"), color = Void.bad) } },
            dismissButton = { TextButton(onClick = { confirmUnpair = false }) { Text(tr("Cancel")) } },
        )
    }
}

@Composable
private fun ToggleCard(title: String, sub: String, on: Boolean, onChange: (Boolean) -> Unit) {
    Card {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(title, fontWeight = FontWeight.Medium)
                Text(sub, color = Void.dim, fontSize = 13.sp)
            }
            Switch(checked = on, onCheckedChange = onChange)
        }
    }
}

/** The desktop's themes, the PC's own saved ones, and tr("Match my PC"), each previewed with the logo in its colours. */
@Composable
private fun ThemePicker() {
    val choice by Themes.choice.collectAsState()
    val iconFollows by Themes.iconFollows.collectAsState()
    val pcState = Portal.state.collectAsState().value
    val pc = remember(pcState) { Themes.pcPalette() }
    val pcThemes = remember(pcState) { Themes.pcThemes() }
    val wallpaper = remember(choice) { Themes.wallpaperPalette() }
    Card {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            ThemeTile(tr("Match my PC"), pc?.name ?: tr("Not seen yet"), pc ?: BUILTIN_THEMES.first(), choice == Themes.MATCH_PC) { Themes.choose(Themes.MATCH_PC) }
            wallpaper?.let { ThemeTile(tr("Match my wallpaper"), "Material You", it, choice == Themes.WALLPAPER) { Themes.choose(Themes.WALLPAPER) } }
            for (t in BUILTIN_THEMES) ThemeTile(t.name.removeSuffix(" (default)"), null, t, choice == t.id) { Themes.choose(t.id) }
            for (t in pcThemes) ThemeTile(t.name, tr("From your PC"), t, choice == t.id) { Themes.choose(t.id) }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(tr("Recolour the app icon too"), fontWeight = FontWeight.Medium)
                Text(tr("Some launchers move the icon when it changes; add it back to the home screen if it disappears."), color = Void.dim, fontSize = 12.sp)
            }
            Switch(checked = iconFollows, onCheckedChange = { Themes.setIconFollows(it) })
        }
    }
}

@Composable
private fun ThemeTile(title: String, sub: String?, palette: Palette, selected: Boolean, onClick: () -> Unit) {
    Column(
        Modifier
            .clip(RoundedCornerShape(14.dp))
            .background(palette.bg)
            .border(if (selected) 2.dp else 1.dp, if (selected) Void.violet else Void.border, RoundedCornerShape(14.dp))
            .clickable(onClick = onClick)
            .padding(10.dp)
            .width(96.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        PortalLogo(Modifier.size(64.dp), palette = palette)
        Spacer(Modifier.height(6.dp))
        Text(title, color = palette.text, fontSize = 12.sp, fontWeight = FontWeight.Medium, maxLines = 1)
        sub?.let { Text(it, color = palette.dim, fontSize = 10.sp, maxLines = 1) }
        Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            for (c in listOf(palette.accent, palette.accent2, palette.ok, palette.warn)) Box(Modifier.size(9.dp).clip(RoundedCornerShape(50)).background(c))
        }
    }
}

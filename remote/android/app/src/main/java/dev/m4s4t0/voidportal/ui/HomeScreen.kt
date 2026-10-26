package dev.m4s4t0.voidportal.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.EditNote
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.m4s4t0.voidportal.Ambience
import dev.m4s4t0.voidportal.Portal
import dev.m4s4t0.voidportal.PortalError
import dev.m4s4t0.voidportal.arr
import dev.m4s4t0.voidportal.bool
import dev.m4s4t0.voidportal.json
import dev.m4s4t0.voidportal.num
import dev.m4s4t0.voidportal.obj
import dev.m4s4t0.voidportal.str
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import dev.m4s4t0.voidportal.tr
import dev.m4s4t0.voidportal.trn

// A getter, so the labels follow the interface language.
private val EFFORTS get() = listOf(null to tr("Default"), "low" to tr("Low"), "medium" to tr("Medium"), "high" to tr("High"), "xhigh" to tr("X-high"), "max" to tr("Max"))

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(onTask: (String) -> Unit, onNewTask: () -> Unit, onSettings: () -> Unit, onPcSettings: () -> Unit, onApproval: (String) -> Unit) {
    val pc by Portal.pc.collectAsState()
    val link by Portal.link.collectAsState()
    val state by Portal.state.collectAsState()
    val tasks by Portal.tasks.collectAsState()
    val approvals by Portal.approvals.collectAsState()
    val snack = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val ambience by Ambience.enabled.collectAsState()
    /** Search across all tasks on the PC (titles, prompts and replies); null while the search bar is closed. */
    var query by rememberSaveable { mutableStateOf<String?>(null) }
    var hits by remember { mutableStateOf<List<JsonObject>?>(null) }
    var searchError by remember { mutableStateOf<String?>(null) }
    BackHandler(enabled = query != null) { query = null; hits = null; searchError = null }
    LaunchedEffect(query) {
        val q = query?.trim() ?: return@LaunchedEffect
        if (q.length < 2) { hits = null; searchError = null; return@LaunchedEffect }
        delay(350)
        try {
            hits = (Portal.call("task.search", json("query" to q)) as JsonArray).mapNotNull { it as? JsonObject }
            searchError = null
        } catch (e: PortalError) {
            hits = null
            searchError = if (e.code == "not-allowed") tr("Update VOID Workshop on the PC to search tasks from here.") else e.message ?: tr("Search failed")
        }
    }

    LaunchedEffect(pc, link) {
        if (pc == Portal.Pc.ONLINE && link == Portal.Link.CONNECTED) runCatching { Portal.refresh() }
    }

    /** Change settings on the PC, then reload what the home screen shows. */
    fun update(vararg patch: Pair<String, Any?>) {
        scope.launch {
            try {
                Portal.call("settings.update", json(*patch))
                Portal.refresh()
            } catch (e: PortalError) {
                snack.showSnackbar(e.message ?: tr("Failed"))
            }
        }
    }

    val active = tasks.filter { it.str("state") in ACTIVE_STATES }
    val recent = tasks.filter { it.str("state") !in ACTIVE_STATES }
    val list = rememberLazyListState()
    // A lazy list stays anchored to its first item, so something arriving above it would appear off screen.
    LaunchedEffect(approvals.size, active.size) { if (list.firstVisibleItemIndex <= 1) list.animateScrollToItem(0) }
    val showError: (String) -> Unit = { m -> scope.launch { snack.showSnackbar(m) } }
    val lists: LazyListScope.() -> Unit = {
        if (approvals.isNotEmpty()) {
            item(key = "h-needs") { SectionTitle(tr("Needs you")) }
            items(approvals, key = { "a-" + (it.str("id") ?: "") }) { a -> ApprovalRow(a, Modifier.animateItem()) { a.str("id")?.let(onApproval) } }
        }
        if (active.isNotEmpty()) {
            item(key = "h-active") { SectionTitle(if (active.size > 1) tr("Active · {n}", "n" to active.size) else tr("Active")) }
            items(active, key = { "t-" + (it.str("id") ?: "") }) { t -> TaskRow(t, state, Modifier.animateItem()) { t.str("id")?.let(onTask) } }
        }
        if (recent.isNotEmpty()) {
            item(key = "h-recent") { SectionTitle(tr("Recent")) }
            items(recent, key = { "t-" + (it.str("id") ?: "") }) { t -> TaskRow(t, state, Modifier.animateItem()) { t.str("id")?.let(onTask) } }
        }
        if (tasks.isEmpty() && state != null) {
            item(key = "empty") {
                Column(Modifier.fillMaxWidth().padding(vertical = 28.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Icon(Icons.Default.AutoAwesome, null, tint = Void.dim, modifier = Modifier.size(28.dp))
                    Text(tr("Nothing running yet"), fontWeight = FontWeight.Medium)
                    Text(tr("Tap New task to start one on your PC."), color = Void.dim, fontSize = 13.sp)
                }
            }
        }
    }

    Scaffold(
        containerColor = Color.Transparent,
        snackbarHost = { SnackbarHost(snack) },
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                title = {
                    query?.let { q ->
                        OutlinedTextField(q, { query = it }, Modifier.fillMaxWidth(), placeholder = { Text(tr("Search tasks")) }, singleLine = true)
                    }
                },
                actions = {
                    if (query != null) {
                        IconButton(onClick = { query = null; hits = null; searchError = null }) { Icon(Icons.Default.Close, tr("Close search")) }
                    } else {
                        if (pc == Portal.Pc.ONLINE) IconButton(onClick = { query = "" }) { Icon(Icons.Default.Search, tr("Search tasks")) }
                        IconButton(onClick = { Ambience.setEnabled(ctx, !ambience) }) {
                            Icon(if (ambience) Icons.AutoMirrored.Filled.VolumeUp else Icons.AutoMirrored.Filled.VolumeOff, if (ambience) tr("Mute the ambience") else tr("Play the ambience"))
                        }
                        IconButton(onClick = { scope.launch { runCatching { Portal.refresh() }.onFailure { snack.showSnackbar(it.message ?: "") } } }) {
                            Icon(Icons.Default.Refresh, tr("Refresh"))
                        }
                        IconButton(onClick = onSettings) { Icon(Icons.Default.Settings, tr("Settings")) }
                    }
                },
            )
        },
        floatingActionButton = {
            if (pc == Portal.Pc.ONLINE && state != null) {
                ExtendedFloatingActionButton(
                    onClick = onNewTask,
                    icon = { Icon(Icons.Default.Add, null) },
                    text = { Text(tr("New task")) },
                    containerColor = Void.violet,
                    contentColor = if (Void.light) Color.White else Void.bg,
                )
            }
        },
    ) { pad ->
        BoxWithConstraints(Modifier.fillMaxSize().padding(pad)) {
            if (query != null) {
                SearchResults(query ?: "", hits, searchError, state, onTask)
            } else if (maxWidth >= 600.dp) {
                // Landscape / tablet: the portal and the engine on the left, the work on the right.
                Row(Modifier.fillMaxSize().padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(20.dp)) {
                    Column(Modifier.weight(0.42f).fillMaxHeight().verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Hero(active.size, approvals.size, compact = true)
                        AdminBanner(showError)
                        UpdateBanner()
                        state?.let { EngineCard(it, ::update, onPcSettings) }
                        state?.let { PlanUsageCard(it) }
                        Spacer(Modifier.height(16.dp))
                    }
                    LazyColumn(
                        Modifier.weight(0.58f).fillMaxHeight(),
                        state = list,
                        contentPadding = PaddingValues(bottom = 96.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                        content = lists,
                    )
                }
            } else {
                LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(16.dp, 0.dp, 16.dp, 96.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    item(key = "hero") { Hero(active.size, approvals.size, compact = false) }
                    item(key = "admin") { AdminBanner(showError) }
                    item(key = "update") { UpdateBanner() }
                    state?.let { s -> item(key = "engine") { EngineCard(s, ::update, onPcSettings) } }
                    state?.let { s -> item(key = "plan-usage") { PlanUsageCard(s) } }
                    lists()
                }
            }
        }
    }
}

/** The portal itself: spins and glows in the PC's status colour, with what is going on underneath. */
@Composable
private fun Hero(working: Int, waiting: Int, compact: Boolean) {
    val pairing by Portal.pairing.collectAsState()
    val link by Portal.link.collectAsState()
    val pc by Portal.pc.collectAsState()
    val error by Portal.lastError.collectAsState()
    val name = pairing?.pcName ?: "PC"
    val online = link == Portal.Link.CONNECTED && pc == Portal.Pc.ONLINE
    val (status, color) = when {
        link != Portal.Link.CONNECTED -> (if (link == Portal.Link.CONNECTING) tr("Connecting to the relay…") else tr("No connection to the relay")) to Void.warn
        pc == Portal.Pc.ONLINE -> tr("Online") to Void.ok
        pc == Portal.Pc.OFFLINE -> tr("Offline") to Void.bad
        else -> tr("Waiting for {name}…", "name" to name) to Void.dim
    }
    val tint by animateColorAsState(color, tween(900), label = "tint")
    val t = rememberInfiniteTransition(label = "hero")
    val spin by t.animateFloat(0f, 360f, infiniteRepeatable(tween(48_000, easing = LinearEasing)), label = "spin")
    val breathe by t.animateFloat(0.85f, 1.2f, infiniteRepeatable(tween(3_400), RepeatMode.Reverse), label = "breathe")
    // An offline portal closes down to a dim ember.
    val reach by animateFloatAsState(if (online) 1f else 0.62f, tween(1_200), label = "reach")
    val logo = if (compact) 120.dp else 148.dp

    Column(Modifier.fillMaxWidth().padding(top = if (compact) 0.dp else 4.dp, bottom = 6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Box(
            Modifier.size(logo + 40.dp).drawBehind {
                val r = size.minDimension / 2f
                drawCircle(Brush.radialGradient(listOf(tint.copy(alpha = 0.30f * breathe), tint.copy(alpha = 0f)), Offset(r, r), r), r)
            },
            contentAlignment = Alignment.Center,
        ) {
            PortalLogo(Modifier.size(logo).rotate(if (online) spin else spin * 0.25f), reach = reach, glow = if (online) breathe else 0.5f)
        }
        Text("VOID PORTAL", color = Void.dim, fontSize = 11.sp, letterSpacing = 3.sp, fontWeight = FontWeight.SemiBold)
        Text(name, fontSize = 26.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.height(6.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Pill(status, tint)
            if (online && working > 0) Pill(tr("{n} active", "n" to working), Void.cyan)
            if (waiting > 0) Pill(trn(waiting, "{n} needs you", "{n} need you"), Void.violet)
        }
        error?.let { Text(it, color = Void.dim, fontSize = 13.sp, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 8.dp)) }
        if (pc == Portal.Pc.OFFLINE) {
            Text(
                tr("Start VOID Workshop on the PC (or turn on \"Start at login\" there)."),
                color = Void.dim,
                fontSize = 13.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 8.dp, start = 12.dp, end = 12.dp),
            )
        }
    }
}

@Composable
private fun Pill(text: String, color: Color) {
    Row(
        Modifier.clip(RoundedCornerShape(50)).background(color.copy(alpha = 0.14f)).border(1.dp, color.copy(alpha = 0.45f), RoundedCornerShape(50)).padding(horizontal = 10.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Box(Modifier.size(7.dp).clip(CircleShape).background(color))
        Text(text, fontSize = 12.sp, fontWeight = FontWeight.Medium, color = Void.text)
    }
}

/** A glassy row with a state-coloured edge; shared by approvals and tasks. */
@Composable
private fun Glass(edge: Color, modifier: Modifier = Modifier, borderColor: Color = Void.border, onClick: () -> Unit, content: @Composable () -> Unit) {
    Row(
        modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .clip(RoundedCornerShape(16.dp))
            .background(Void.panel.copy(alpha = 0.78f))
            .border(1.dp, borderColor, RoundedCornerShape(16.dp))
            .clickable(onClick = onClick),
    ) {
        Box(Modifier.width(4.dp).fillMaxHeight().background(Brush.verticalGradient(listOf(edge, edge.copy(alpha = 0.25f)))))
        Box(Modifier.weight(1f)) { content() }
    }
}

@Composable
private fun ApprovalRow(a: JsonObject, modifier: Modifier, onClick: () -> Unit) {
    val pulse by rememberInfiniteTransition(label = "needs").animateFloat(0.35f, 0.9f, infiniteRepeatable(tween(1_600), RepeatMode.Reverse), label = "pulse")
    Glass(Void.violet, modifier, borderColor = Void.violet.copy(alpha = pulse), onClick = onClick) {
        Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(if (a.str("kind") == "command") Icons.Default.Terminal else Icons.Default.EditNote, null, tint = Void.violet)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(a.str("summary") ?: tr("Approval"), fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                (a.str("command") ?: a.str("rel"))?.let { Text(it, color = Void.dim, fontSize = 12.sp, fontFamily = FontFamily.Monospace, maxLines = 2, overflow = TextOverflow.Ellipsis) }
            }
            Text(tr("Review"), color = Void.violet, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
        }
    }
}

@Composable
private fun SearchResults(query: String, hits: List<JsonObject>?, error: String?, pcState: JsonObject?, onTask: (String) -> Unit) {
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp, 4.dp, 16.dp, 96.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        val note = when {
            error != null -> error
            query.trim().length < 2 -> tr("Type at least two letters.")
            hits == null -> tr("Searching…")
            hits.isEmpty() -> tr("No tasks match.")
            else -> null
        }
        if (note != null) item(key = "note") { Text(note, color = Void.dim, fontSize = 13.sp, modifier = Modifier.padding(vertical = 8.dp)) }
        items(hits.orEmpty(), key = { "s-" + (it.obj("task")?.str("id") ?: "") }) { h ->
            val t = h.obj("task") ?: return@items
            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                TaskRow(t, pcState, Modifier) { t.str("id")?.let(onTask) }
                h.str("snippet")?.let { Text(it, color = Void.dim, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 14.dp)) }
            }
        }
    }
}

@Composable
private fun TaskRow(t: JsonObject, pcState: JsonObject?, modifier: Modifier, onClick: () -> Unit) {
    val st = t.str("state")
    val running = st in RUNNING_STATES
    val model = t.str("model")
    val modelName = pcState?.obj("models")?.let { m -> (m.arr("anthropic") + m.arr("ollama")).firstOrNull { it.str("id") == model }?.str("displayName") } ?: model
    Glass(stateColor(st), modifier, onClick = onClick) {
        Column {
            Column(Modifier.padding(start = 14.dp, end = 14.dp, top = 12.dp, bottom = if (running) 8.dp else 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(t.str("title") ?: tr("Task"), Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium)
                    Spacer(Modifier.width(8.dp))
                    StateBadge(st)
                }
                val meta = listOfNotNull(projectName(t.str("project")).ifBlank { null }, modelName, ago(t.num("updated_at")).ifBlank { null })
                Text(meta.joinToString("  ·  "), color = Void.dim, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (running) LinearProgressIndicator(Modifier.fillMaxWidth().height(2.dp), color = stateColor(st), trackColor = Color.Transparent)
        }
    }
}

/** What the PC runs on, in one line; tap to open the controls. */
@Composable
private fun EngineCard(s: JsonObject, update: (Array<out Pair<String, Any?>>) -> Unit, onPcSettings: () -> Unit) {
    var open by rememberSaveable { mutableStateOf(false) }
    val settings = s.obj("settings") ?: JsonObject(emptyMap())
    val provider = settings.str("provider") ?: "anthropic"
    val auth = settings.str("anthropicAuth") ?: "api-key"
    val runsOn = if (provider == "ollama") "Ollama" else if (auth == "subscription") tr("Claude plan") else tr("API key")
    val models = s.obj("models")?.arr(if (provider == "ollama") "ollama" else "anthropic") ?: emptyList()
    val current = settings.str("model")
    val modelName = models.firstOrNull { it.str("id") == current }?.str("displayName") ?: current ?: tr("No model")
    val extras = listOfNotNull(
        settings.str("effort")?.takeIf { provider != "ollama" }?.let { e -> EFFORTS.firstOrNull { it.first == e }?.second?.let { tr("{level} effort", "level" to it) } },
        tr("Fast").takeIf { provider != "ollama" && settings.bool("fastMode") == true },
    )
    val chevron by animateFloatAsState(if (open) 180f else 0f, label = "chevron")
    Card {
        Row(Modifier.fillMaxWidth().clickable { open = !open }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Column(Modifier.weight(1f)) {
                Text(tr("ENGINE"), color = Void.dim, fontSize = 10.sp, letterSpacing = 2.sp, fontWeight = FontWeight.SemiBold)
                Text("$runsOn  ·  $modelName", fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (extras.isNotEmpty()) Text(extras.joinToString("  ·  "), color = Void.dim, fontSize = 12.sp)
            }
            Icon(Icons.Default.ExpandMore, if (open) tr("Hide") else tr("Change"), tint = Void.dim, modifier = Modifier.rotate(chevron))
        }
        AnimatedVisibility(open, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                EngineControls(s, update)
                TextButton(onClick = onPcSettings) { Text(tr("All PC settings")) }
            }
        }
    }
}

@Composable
private fun EngineControls(s: JsonObject, update: (Array<out Pair<String, Any?>>) -> Unit) {
    val settings = s.obj("settings") ?: JsonObject(emptyMap())
    val provider = settings.str("provider") ?: "anthropic"
    val auth = settings.str("anthropicAuth") ?: "api-key"
    val selected = if (provider == "ollama") 2 else if (auth == "subscription") 0 else 1
    val sub = s.obj("subscription")
    val limited = s.obj("planLimited")?.takeIf { (it.num("until") ?: 0.0) > System.currentTimeMillis() }
    fun set(vararg p: Pair<String, Any?>) = update(p)

    SectionTitle(tr("Runs on"))
    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
        val options = listOf(tr("Claude plan"), tr("API key"), "Ollama")
        options.forEachIndexed { i, label ->
            SegmentedButton(
                selected = selected == i,
                onClick = {
                    when (i) {
                        0 -> set("provider" to "anthropic", "anthropicAuth" to "subscription")
                        1 -> set("provider" to "anthropic", "anthropicAuth" to "api-key")
                        else -> set("provider" to "ollama")
                    }
                },
                shape = SegmentedButtonDefaults.itemShape(i, options.size),
            ) { Text(label, fontSize = 13.sp) }
        }
    }
    val status = when (selected) {
        0 -> when {
            sub?.bool("signedIn") != true -> tr("Not signed in to a Claude plan on the PC") to Void.bad
            limited != null -> (limited.str("message") ?: tr("Plan limit reached")) to Void.warn
            else -> tr("Signed in") + (sub.str("subscriptionType")?.let { " · $it" } ?: "") to Void.ok
        }
        1 -> when {
            s.bool("keyConfigured") != true -> tr("No API key on the PC") to Void.bad
            s.obj("billingBlocked") != null -> tr("Stopped after a billing error") to Void.bad
            else -> tr("Today ≈ {spent} of {budget}", "spent" to "$%.2f".format(s.num("spentTodayUsd") ?: 0.0), "budget" to "$%.2f".format(settings.num("dailyBudgetUsd") ?: 0.0)) to Void.ok
        }
        else -> tr("Local models on the PC, free") to Void.ok
    }
    StatusLine(status.second, status.first)
    if (selected != 2) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(tr("Switch when one runs out"), Modifier.weight(1f), fontSize = 14.sp)
            Switch(checked = settings.bool("authFallback") == true, onCheckedChange = { set("authFallback" to it) })
        }
    }

    SectionTitle(tr("Model"))
    val models = s.obj("models")?.arr(if (provider == "ollama") "ollama" else "anthropic") ?: emptyList()
    val current = settings.str("model")
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { open = true }, modifier = Modifier.fillMaxWidth()) {
            Text(models.firstOrNull { it.str("id") == current }?.str("displayName") ?: current ?: tr("Choose a model"), Modifier.weight(1f), maxLines = 1)
            Icon(Icons.Default.ArrowDropDown, null)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            if (models.isEmpty()) DropdownMenuItem(text = { Text(tr("No models: refresh the list on the PC")) }, onClick = { open = false })
            for (m in models) {
                DropdownMenuItem(
                    text = { Column { Text(m.str("displayName") ?: ""); Text(m.str("id") ?: "", color = Void.dim, fontSize = 11.sp) } },
                    onClick = {
                        open = false
                        set("model" to m.str("id"))
                    },
                )
            }
        }
    }
    if (provider != "ollama") {
        SectionTitle(tr("Effort"))
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            for ((id, label) in EFFORTS) FilterChip(selected = settings.str("effort") == id, onClick = { set("effort" to id) }, label = { Text(label) })
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(tr("Fast mode"), fontSize = 14.sp)
                Text(tr("Faster output, higher price"), color = Void.dim, fontSize = 12.sp)
            }
            Switch(checked = settings.bool("fastMode") == true, onCheckedChange = { set("fastMode" to it) })
        }
    }
}

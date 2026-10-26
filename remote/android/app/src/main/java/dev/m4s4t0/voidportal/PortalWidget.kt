package dev.m4s4t0.voidportal

import android.content.Context
import android.graphics.Bitmap
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalSize
import androidx.glance.action.ActionParameters
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.LinearProgressIndicator
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.updateAll
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.ContentScale
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import dev.m4s4t0.voidportal.ui.Void
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Home screen widget: plan usage, what needs you, and the chats with the agent's latest reply, readable
 * without opening the app. It draws a snapshot saved on every change, so it still shows the last state
 * after the process was stopped.
 */
object PortalWidgetData {
    private const val PREFS = "portal_widget"
    private const val KEY = "snapshot"

    fun load(ctx: Context): JsonObject? =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null)?.let { runCatching { parseJson(it) as JsonObject }.getOrNull() }

    private fun save(ctx: Context, snap: JsonObject) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, snap.toString()).apply()
    }

    private fun snapshot(prev: JsonObject?): JsonObject {
        val link = Portal.link.value
        val pc = Portal.pc.value
        val status = when {
            Portal.pairing.value == null -> tr("Not paired")
            link != Portal.Link.CONNECTED -> tr("No connection")
            pc == Portal.Pc.ONLINE -> tr("Online")
            pc == Portal.Pc.OFFLINE -> tr("PC offline")
            else -> tr("Waiting for the PC")
        }
        // Working first, then the latest; the agent's reply is cut to what fits in two lines.
        val tasks = Portal.tasks.value
            .sortedWith(compareByDescending<JsonObject> { it.str("state") in WORKING }.thenByDescending { it.num("updated_at") ?: 0.0 })
            .take(8)
            .map { t ->
                buildJsonObject {
                    put("id", t.str("id"))
                    put("title", t.str("title"))
                    put("state", t.str("state"))
                    put("project", t.str("project")?.substringAfterLast('/'))
                    put("summary", t.str("summary")?.replace(Regex("\\s+"), " ")?.take(160))
                }
            }
        val approvals = Portal.approvals.value.take(4).map { a ->
            buildJsonObject {
                put("id", a.str("id"))
                put("taskId", a.str("taskId"))
                put("summary", a.str("summary"))
            }
        }
        return buildJsonObject {
            put("pc", Portal.pairing.value?.pcName ?: tr("PC"))
            put("status", status)
            put("online", link == Portal.Link.CONNECTED && pc == Portal.Pc.ONLINE)
            put("savedAt", System.currentTimeMillis())
            // Until the PC's state has loaded (app just started, PC offline), keep showing the last known one.
            val loaded = Portal.state.value != null
            put("tasks", if (loaded) JsonArray(tasks) else prev?.get("tasks") ?: JsonArray(emptyList()))
            put("approvals", if (loaded) JsonArray(approvals) else prev?.get("approvals") ?: JsonArray(emptyList()))
            (Portal.planUsage.value ?: prev?.obj("plan"))?.let { put("plan", it) }
        }
    }

    /** The theme changed: draw the widget in the new colours. */
    fun redraw(ctx: Context) {
        Portal.launch { runCatching { PortalWidget().updateAll(ctx.applicationContext) } }
    }

    /** Follow Portal's state for as long as the process lives (the background service keeps it alive). */
    @OptIn(FlowPreview::class)
    fun follow(ctx: Context) {
        val app = ctx.applicationContext
        Portal.launch {
            combine(Portal.link, Portal.pc, Portal.tasks, Portal.approvals, Portal.planUsage) { _, _, _, _, _ -> snapshot(load(app)) }
                .map { it.toString().let { s -> s to it } }
                .debounce(800)
                .distinctUntilChanged { a, b -> a.first.replace(SAVED_AT, "") == b.first.replace(SAVED_AT, "") }
                .collect { (_, snap) ->
                    save(app, snap)
                    runCatching { PortalWidget().updateAll(app) }
                }
        }
        // With the app closed nothing loads the PC's state; the widget needs it.
        Portal.launch {
            Portal.pc.collect { pc -> if (pc == Portal.Pc.ONLINE) runCatching { Portal.refresh() } }
        }
    }

    private val SAVED_AT = Regex("\"savedAt\":\\d+")
    val WORKING = setOf("planning", "executing", "awaiting-plan-approval")
}

class PortalWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = PortalWidget()
}

/** The refresh button: reconnect if needed and reload everything from the PC. */
class RefreshWidgetAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        Portal.init(context)
        PortalService.start(context)
        runCatching { Portal.refresh() }
        runCatching { Portal.call("plan.usage") }
    }
}

class PortalWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        // The same theme as the app (its own choice, or "Match my PC").
        Themes.init(context)
        val snap = PortalWidgetData.load(context)
        val icon = themedIcon(context)
        provideContent { Content(context, snap, icon) }
    }

    private fun open(ctx: Context, taskId: String? = null, approvalId: String? = null) =
        actionStartActivity(
            Intent(ctx, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                // A distinct data uri per target keeps each tap's extras apart.
                .setData(android.net.Uri.parse("voidportal-widget://open/${taskId ?: "-"}/${approvalId ?: "-"}"))
                .apply {
                    taskId?.let { putExtra(Notifier.EXTRA_TASK, it) }
                    approvalId?.let { putExtra(Notifier.EXTRA_APPROVAL, it) }
                },
        )

    @Composable
    private fun Content(ctx: Context, snap: JsonObject?, icon: Bitmap?) {
        val size = LocalSize.current
        val text = ColorProvider(Void.text)
        val dim = ColorProvider(Void.dim)
        val rows = snap?.obj("plan")?.arr("rows") ?: emptyList()
        val approvals = snap?.arr("approvals") ?: emptyList()
        val tasks = snap?.arr("tasks") ?: emptyList()
        // As many cards as the widget is tall (a plain column draws the same in every launcher).
        val room = size.height.value - 64 - (if (rows.isNotEmpty()) 44 else 0)
        val fit = (room / 62).toInt().coerceIn(0, 8)
        val shownApprovals = approvals.take(minOf(2, fit))
        val shownTasks = tasks.take(fit - shownApprovals.size)

        Box(GlanceModifier.fillMaxSize().cornerRadius(22.dp)) {
            Image(ImageProvider(cosmos(size.width.value, size.height.value)), null, GlanceModifier.fillMaxSize(), contentScale = ContentScale.FillBounds)
            Column(GlanceModifier.fillMaxSize().padding(12.dp)) {
                Row(GlanceModifier.fillMaxWidth().clickable(open(ctx)), verticalAlignment = Alignment.CenterVertically) {
                    if (icon != null) {
                        Image(ImageProvider(icon), "VOID Portal", GlanceModifier.size(28.dp))
                        Spacer(GlanceModifier.width(8.dp))
                    }
                    Column(GlanceModifier.defaultWeight()) {
                        Text("VOID PORTAL", style = TextStyle(color = ColorProvider(Void.violet), fontSize = 11.sp, fontWeight = FontWeight.Bold))
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(GlanceModifier.size(7.dp).cornerRadius(4.dp).background(if (snap?.bool("online") == true) Void.ok else Void.warn)) {}
                            Spacer(GlanceModifier.width(5.dp))
                            Text("${snap?.str("pc") ?: tr("PC")} · ${snap?.str("status") ?: tr("Open Portal to pair")}", style = TextStyle(color = dim, fontSize = 11.sp), maxLines = 1)
                        }
                    }
                    Text("⟳", style = TextStyle(color = dim, fontSize = 18.sp), modifier = GlanceModifier.padding(6.dp).clickable(actionRunCallback<RefreshWidgetAction>()))
                }
                Spacer(GlanceModifier.height(10.dp))
                if (rows.isNotEmpty()) {
                    Row(GlanceModifier.fillMaxWidth()) {
                        rows.take(3).forEachIndexed { i, r ->
                            if (i > 0) Spacer(GlanceModifier.width(8.dp))
                            val pct = (r.num("percent") ?: 0.0).coerceIn(0.0, 100.0)
                            val tone = when {
                                r.str("severity") == "critical" || pct >= 90 -> Void.bad
                                r.str("severity") == "warning" || pct >= 75 -> Void.warn
                                else -> Void.cyan
                            }
                            Column(GlanceModifier.defaultWeight()) {
                                Text("${shortLabel(r)} ${pct.toInt()}%", style = TextStyle(color = text, fontSize = 12.sp, fontWeight = FontWeight.Medium), maxLines = 1)
                                Spacer(GlanceModifier.height(3.dp))
                                LinearProgressIndicator(
                                    progress = (pct / 100).toFloat(),
                                    modifier = GlanceModifier.fillMaxWidth().height(4.dp),
                                    color = ColorProvider(tone),
                                    backgroundColor = ColorProvider(Void.panelAlt),
                                )
                            }
                        }
                    }
                    Spacer(GlanceModifier.height(10.dp))
                }
                if (approvals.isEmpty() && tasks.isEmpty()) {
                    Text(if (snap == null) tr("Open VOID Portal once to fill this in.") else tr("No chats yet."), style = TextStyle(color = dim, fontSize = 13.sp))
                }
                for (a in shownApprovals) {
                    Card(open(ctx, a.str("taskId"), a.str("id")), accent = true) {
                        Text(tr("Needs you"), style = TextStyle(color = ColorProvider(Void.violet), fontSize = 11.sp, fontWeight = FontWeight.Bold))
                        Text(a.str("summary") ?: "", style = TextStyle(color = text, fontSize = 13.sp), maxLines = 2)
                    }
                }
                for (t in shownTasks) {
                    val st = t.str("state") ?: ""
                    Card(open(ctx, t.str("id"))) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(GlanceModifier.size(6.dp).cornerRadius(3.dp).background(stateColor(st))) {}
                            Spacer(GlanceModifier.width(6.dp))
                            Text(t.str("title") ?: tr("Task"), style = TextStyle(color = text, fontSize = 13.sp, fontWeight = FontWeight.Medium), maxLines = 1, modifier = GlanceModifier.defaultWeight())
                            Spacer(GlanceModifier.width(8.dp))
                            Text(t.str("project") ?: "", style = TextStyle(color = dim, fontSize = 11.sp), maxLines = 1)
                        }
                        val line = if (st == "executing" || st == "planning") tr("Working…") else t.str("summary") ?: stateText(st)
                        Text(line, style = TextStyle(color = dim, fontSize = 12.sp), maxLines = 2)
                    }
                }
                val more = approvals.size - shownApprovals.size + tasks.size - shownTasks.size
                if (more > 0) Text(tr("+{n} more · tap to open", "n" to more), style = TextStyle(color = dim, fontSize = 11.sp), modifier = GlanceModifier.clickable(open(ctx)))
            }
        }
    }

    @Composable
    private fun Card(onClick: androidx.glance.action.Action, accent: Boolean = false, content: @Composable () -> Unit) {
        Column(GlanceModifier.fillMaxWidth().padding(bottom = 6.dp)) {
            Column(
                GlanceModifier.fillMaxWidth()
                    .background(if (accent) Void.mix(Void.panel, Void.violet, 0.22f).copy(alpha = 0.9f) else Void.panel.copy(alpha = 0.82f))
                    .cornerRadius(12.dp)
                    .padding(horizontal = 10.dp, vertical = 7.dp)
                    .clickable(onClick),
            ) { content() }
        }
    }

    /** Portal's look: the theme's background with an accent glow and a few stars. */
    private fun cosmos(wDp: Float, hDp: Float): Bitmap {
        val scale = 360f / maxOf(wDp, hDp, 1f)
        val w = (wDp * scale).toInt().coerceAtLeast(8)
        val h = (hDp * scale).toInt().coerceAtLeast(8)
        val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val c = android.graphics.Canvas(bmp)
        c.drawColor(Void.bg.copy(alpha = 0.94f).toArgb())
        fun glow(x: Float, y: Float, r: Float, color: Color, alpha: Float) {
            val paint = android.graphics.Paint().apply {
                shader = android.graphics.RadialGradient(x, y, r, color.copy(alpha = alpha).toArgb(), android.graphics.Color.TRANSPARENT, android.graphics.Shader.TileMode.CLAMP)
            }
            c.drawCircle(x, y, r, paint)
        }
        glow(w * 0.92f, h * 0.05f, maxOf(w, h) * 0.7f, Void.violet, if (Void.light) 0.18f else 0.30f)
        glow(w * 0.05f, h * 0.98f, maxOf(w, h) * 0.6f, Void.cyan, if (Void.light) 0.10f else 0.16f)
        if (!Void.light) {
            val star = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG)
            val rnd = java.util.Random(7)
            repeat(40) {
                star.color = Void.text.copy(alpha = 0.15f + rnd.nextFloat() * 0.45f).toArgb()
                c.drawCircle(rnd.nextFloat() * w, rnd.nextFloat() * h, 0.4f + rnd.nextFloat() * 0.9f, star)
            }
        }
        return bmp
    }

    /** The theme's own Portal icon (the same one the launcher shows), round. */
    private fun themedIcon(ctx: Context): Bitmap? = runCatching {
        val name = "ic_launcher_" + Void.palette.id.replace('-', '_')
        val res = ctx.resources.getIdentifier(name, "mipmap", ctx.packageName).takeIf { it != 0 } ?: R.mipmap.ic_launcher
        val d = androidx.core.content.ContextCompat.getDrawable(ctx, res) ?: return null
        val px = 96
        val bmp = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
        val c = android.graphics.Canvas(bmp)
        val path = android.graphics.Path().apply { addCircle(px / 2f, px / 2f, px / 2f, android.graphics.Path.Direction.CW) }
        c.clipPath(path)
        // An adaptive icon draws a little past its mask; inset like a launcher would.
        val pad = -(px * 0.08f).toInt()
        d.setBounds(pad, pad, px - pad, px - pad)
        d.draw(c)
        bmp
    }.getOrNull()

    private fun shortLabel(r: JsonObject): String = when (r.str("kind")) {
        "session" -> "5h"
        "weekly_all" -> tr("Week")
        else -> (r.str("label") ?: "").removeSuffix(" limit")
    }

    private fun stateColor(st: String): Color = when (st) {
        "executing", "planning" -> Void.cyan
        "awaiting-plan-approval" -> Void.violet
        "idle", "completed" -> Void.ok
        "failed", "stopped-billing", "stopped-limit", "stopped-budget", "interrupted" -> Void.bad
        else -> Void.dim
    }

    private fun stateText(st: String): String = when (st) {
        "idle" -> tr("Waiting for you")
        "completed" -> tr("Done")
        "awaiting-plan-approval" -> tr("Plan ready for review")
        "failed" -> tr("Failed")
        "cancelled" -> tr("Stopped")
        "interrupted" -> tr("Interrupted")
        else -> st.replace('-', ' ')
    }
}

private fun parseJson(s: String) = kotlinx.serialization.json.Json.parseToJsonElement(s)

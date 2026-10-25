package dev.m4s4t0.voidportal.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.m4s4t0.voidportal.Portal
import dev.m4s4t0.voidportal.PortalError
import dev.m4s4t0.voidportal.arr
import dev.m4s4t0.voidportal.bool
import dev.m4s4t0.voidportal.json
import dev.m4s4t0.voidportal.num
import dev.m4s4t0.voidportal.obj
import dev.m4s4t0.voidportal.str
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

private fun resetText(at: Double?, now: Long): String {
    if (at == null) return ""
    val mins = ((at - now) / 60_000).toLong()
    return when {
        mins <= 0 -> "resetting now"
        mins < 60 -> "resets in ${mins}m"
        mins < 24 * 60 -> "resets in ${mins / 60}h ${mins % 60}m"
        else -> "resets " + SimpleDateFormat("EEE HH:mm", Locale.getDefault()).format(Date(at.toLong()))
    }
}

private fun ago(at: Double?, now: Long): String {
    if (at == null || at <= 0) return "not checked yet"
    val mins = ((now - at) / 60_000).toLong()
    return if (mins < 1) "checked just now" else if (mins < 60) "checked ${mins}m ago" else "checked ${mins / 60}h ago"
}

private fun toneOf(row: JsonObject): Color {
    val pct = row.num("percent") ?: 0.0
    return when {
        row.str("severity") == "critical" || pct >= 90 -> Void.bad
        row.str("severity") == "warning" || pct >= 75 -> Void.warn
        else -> Void.cyan
    }
}

/** Claude plan usage like Claude Code's usage bar: 5-hour session, weekly, per model (Fable…), extra usage. */
@Composable
fun PlanUsageCard(s: JsonObject) {
    val usage by Portal.planUsage.collectAsState()
    val settings = s.obj("settings") ?: return
    if (settings.str("provider") == "ollama" || s.obj("subscription")?.bool("signedIn") != true) return
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    val scope = rememberCoroutineScope()
    // Countdowns move on their own; the numbers arrive as plan.usage events.
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000)
            now = System.currentTimeMillis()
        }
    }
    val rows = usage?.arr("rows") ?: emptyList()

    Card {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("CLAUDE PLAN USAGE", color = Void.dim, fontSize = 10.sp, letterSpacing = 2.sp, fontWeight = FontWeight.SemiBold)
                Text(
                    listOfNotNull(usage?.str("subscriptionType")?.replaceFirstChar { it.uppercase() }, ago(usage?.num("checkedAt"), now)).joinToString("  ·  "),
                    color = Void.dim,
                    fontSize = 12.sp,
                )
            }
            if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
            else IconButton(onClick = {
                busy = true
                error = null
                scope.launch {
                    try {
                        (Portal.call("plan.usage", json("force" to true)) as? JsonObject)?.let { Portal.planUsage.value = it }
                    } catch (e: PortalError) {
                        error = e.message
                    } finally {
                        busy = false
                    }
                }
            }) { Icon(Icons.Default.Refresh, "Check again", tint = Void.dim) }
        }
        if (rows.isEmpty()) Text(if (usage?.str("problem") != null) "Not available right now" else "Checking…", color = Void.dim, fontSize = 13.sp)
        Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
            for (r in rows) {
                val pct = (r.num("percent") ?: 0.0).coerceIn(0.0, 100.0)
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(r.str("label") ?: "", Modifier.weight(1f), fontSize = 14.sp, fontWeight = FontWeight.Medium)
                        Text("${pct.toInt()}%", color = toneOf(r), fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                    }
                    LinearProgressIndicator(
                        progress = { (pct / 100).toFloat() },
                        modifier = Modifier.fillMaxWidth().height(6.dp).clip(RoundedCornerShape(3.dp)),
                        color = toneOf(r),
                        trackColor = Void.panelAlt,
                        drawStopIndicator = {},
                    )
                    resetText(r.num("resetsAt"), now).takeIf { it.isNotEmpty() }?.let { Text(it, color = Void.dim, fontSize = 12.sp) }
                }
            }
            usage?.obj("extra")?.let { x ->
                val cur = x.str("currency") ?: "USD"
                fun money(v: Double?) = if (v == null) "—" else java.text.NumberFormat.getCurrencyInstance(Locale.getDefault()).apply {
                    currency = java.util.Currency.getInstance(cur)
                }.format(v)
                val on = x.bool("enabled") == true
                val reason = x.str("reason")?.replace('_', ' ')
                Text(
                    "Extra usage ${money(x.num("used"))} / ${money(x.num("limit"))} · " + if (on) "on" else "off${reason?.let { " ($it)" } ?: ""}",
                    color = Void.dim,
                    fontSize = 12.sp,
                )
            }
        }
        (error ?: usage?.str("problem"))?.let { Text(it, color = Void.warn, fontSize = 12.sp) }
    }
}

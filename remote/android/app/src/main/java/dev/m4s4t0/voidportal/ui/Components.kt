package dev.m4s4t0.voidportal.ui

import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

@Composable
fun Card(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(Void.panel.copy(alpha = 0.82f))
            .border(1.dp, Void.border, RoundedCornerShape(14.dp))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
        content = content,
    )
}

@Composable
fun SectionTitle(text: String) {
    Text(text.uppercase(), color = Void.dim, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, letterSpacing = 1.sp, modifier = Modifier.padding(top = 6.dp))
}

/** A status dot; [pulse] makes it breathe (something is running). */
@Composable
fun Dot(color: Color, pulse: Boolean = false) {
    if (!pulse) {
        Box(Modifier.size(9.dp).clip(CircleShape).background(color))
        return
    }
    val t = rememberInfiniteTransition(label = "pulse")
    val f by t.animateFloat(0f, 1f, infiniteRepeatable(tween(1100, easing = FastOutSlowInEasing), RepeatMode.Restart), label = "pulse")
    Box(Modifier.size(9.dp), contentAlignment = Alignment.Center) {
        // A ring that grows and fades around a steady core.
        Box(Modifier.size(9.dp).graphicsLayer { scaleX = 1f + f * 1.2f; scaleY = 1f + f * 1.2f; alpha = (1f - f) * 0.6f }.clip(CircleShape).background(color))
        Box(Modifier.size(7.dp).clip(CircleShape).background(color))
    }
}

@Composable
fun StatusLine(color: Color, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Dot(color)
        Text(text, color = Void.text, fontSize = 14.sp)
    }
}

private val STATE_LABEL = mapOf(
    "planning" to ("Planning" to Void.cyan),
    "awaiting-plan-approval" to ("Plan ready" to Void.violet),
    "executing" to ("Working" to Void.cyan),
    "idle" to ("Waiting for you" to Void.violet),
    "completed" to ("Completed" to Void.ok),
    "cancelled" to ("Cancelled" to Void.dim),
    "failed" to ("Failed" to Void.bad),
    "stopped-budget" to ("Limit reached" to Void.warn),
    "stopped-billing" to ("Billing stop" to Void.bad),
    "stopped-limit" to ("Plan limit" to Void.warn),
    "interrupted" to ("Interrupted" to Void.warn),
)

val RUNNING_STATES = setOf("planning", "executing")

/** Waiting on the user or working: the home screen lists these under "Active". */
val ACTIVE_STATES = RUNNING_STATES + setOf("idle", "awaiting-plan-approval")

fun stateColor(state: String?): Color = STATE_LABEL[state]?.second ?: Void.dim

@Composable
fun StateBadge(state: String?) {
    val (label, color) = STATE_LABEL[state] ?: ((state ?: "") to Void.dim)
    Row(
        Modifier.clip(RoundedCornerShape(50)).border(1.dp, color.copy(alpha = 0.6f), RoundedCornerShape(50)).padding(horizontal = 8.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        if (state in RUNNING_STATES) Dot(color, pulse = true)
        Text(label, color = color, fontSize = 11.sp, fontWeight = FontWeight.SemiBold)
    }
}

fun projectName(path: String?): String = path?.trimEnd('/')?.substringAfterLast('/') ?: ""

fun formatTokens(n: Double): String = when {
    n >= 1_000_000 -> "%.1fM".format(n / 1_000_000)
    n >= 1000 -> "%.0fk".format(n / 1000)
    else -> "%.0f".format(n)
}

/** "now", "5 min", "3 h", "2 d" since an epoch-millis time. */
fun ago(ms: Double?): String {
    ms ?: return ""
    val min = ((System.currentTimeMillis() - ms) / 60_000).toLong()
    return when {
        min < 1 -> "now"
        min < 60 -> "$min min"
        min < 60 * 24 -> "${min / 60} h"
        else -> "${min / (60 * 24)} d"
    }
}

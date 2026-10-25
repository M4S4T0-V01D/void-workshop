package dev.m4s4t0.voidportal.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random

/** [twinkles] is a whole number of twinkle cycles per loop, so the loop has no visible seam. */
private class Star(val x: Float, val y: Float, val r: Float, val phase: Float, val twinkles: Int, val depth: Float, val tint: Int)

/**
 * The app's living backdrop: slow nebula clouds drifting through deep space, stars that twinkle and
 * drift with a little parallax. Everything moves on long loops, so it stays calm behind the content.
 */
@Composable
fun CosmicBackground(modifier: Modifier = Modifier) {
    val stars = remember {
        val rnd = Random(42)
        List(110) {
            val tint = rnd.nextInt(6) // 0: second accent, 1: accent, else white
            Star(rnd.nextFloat(), rnd.nextFloat(), 0.5f + rnd.nextFloat() * 1.4f, rnd.nextFloat() * 6.28f, 18 + rnd.nextInt(40), 0.2f + rnd.nextFloat() * 0.8f, tint)
        }
    }
    val t = rememberInfiniteTransition(label = "cosmos")
    // One slow master clock (90 s per loop) drives every motion, so the loop is seamless.
    val clock by t.animateFloat(0f, 1f, infiniteRepeatable(tween(90_000, easing = LinearEasing), RepeatMode.Restart), label = "clock")
    // Colours follow the theme: deep space for dark themes, a pale sky with soft colour for light ones.
    val p = Void.palette
    val top = if (p.light) lerp(p.panelAlt, p.accent, 0.06f) else lerp(p.bg, p.accent, 0.08f)
    val bottom = if (p.light) p.bg else lerp(p.bg, Color.Black, 0.3f)
    val cloudColors = listOf(p.accent, p.accent2, lerp(p.accent, p.bad, 0.5f)).map { if (p.light) it.copy(alpha = 0.16f) else lerp(p.bg, it, 0.45f).copy(alpha = 0.55f) }
    val starColors = if (p.light) listOf(p.accent2, p.accent, p.accent).map { it.copy(alpha = 0.35f) } else listOf(lerp(p.accent2, Color.White, 0.6f), lerp(p.accent, Color.White, 0.6f), Color.White)
    Canvas(modifier.fillMaxSize()) {
        val w = size.width
        val h = size.height
        val a = clock * 2f * PI.toFloat()
        drawRect(Brush.verticalGradient(listOf(top, bottom)))
        // Nebula clouds on slow Lissajous paths.
        val clouds = listOf(0.55f to 0f, 0.45f to 2.1f, 0.38f to 4.2f)
        for ((i, c) in clouds.withIndex()) {
            val (radius, ph) = c
            val color = cloudColors[i]
            val cx = w * (0.5f + 0.32f * sin(a * (i + 1) + ph))
            val cy = h * (0.45f + 0.28f * cos(a * (2 - i % 2) + ph * 0.7f))
            val r = radius * maxOf(w, h) * (0.9f + 0.1f * sin(a * 3 + ph))
            drawCircle(Brush.radialGradient(listOf(color, color.copy(alpha = 0f)), Offset(cx, cy), r), r, Offset(cx, cy))
        }
        // Stars: twinkle, and sway on slow orbits; nearer stars sway further (parallax).
        for (s in stars) {
            val y = s.y + 0.02f * s.depth * sin(a + s.phase)
            val x = s.x + 0.012f * s.depth * cos(a * 2 + s.phase)
            val tw = 0.35f + 0.65f * (0.5f + 0.5f * sin(a * s.twinkles + s.phase))
            val tint = starColors[minOf(s.tint, 2)]
            drawCircle(tint.copy(alpha = tint.alpha * tw * (0.4f + 0.6f * s.depth)), s.r * s.depth * density, Offset(x * w, y * h))
        }
    }
}

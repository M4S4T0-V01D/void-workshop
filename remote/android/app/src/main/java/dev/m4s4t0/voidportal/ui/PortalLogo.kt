package dev.m4s4t0.voidportal.ui

import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.lerp
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/**
 * The VOID Portal logo, drawn live: same geometry as art/gen_icon.py (108-unit grid).
 * [spin] rotates the arms (degrees), [reach] grows them out of the centre (0..1), [glow] scales their halo.
 */
@Composable
fun PortalLogo(modifier: Modifier = Modifier, spin: Float = 0f, reach: Float = 1f, glow: Float = 1f, showRing: Boolean = true, palette: Palette = Void.palette) {
    val colors = LogoColors.from(palette)
    Canvas(modifier) {
        val s = min(size.width, size.height) / 108f
        translate((size.width - 108f * s) / 2f, (size.height - 108f * s) / 2f) {
            scale(s, s, pivot = Offset.Zero) { drawLogo(colors, spin, reach, glow, showRing) }
        }
    }
}

/** The logo's colours for a theme; the same mapping as palette() in art/gen_icon.py, so it matches the app icon. */
private class LogoColors(val ring: List<Color>, val arms: List<Color>, val hot: Color, val core: List<Color>, val glow: Color, val sparkEnd: Color) {
    companion object {
        private val DEEP = Color(0xFF0B0820)

        fun from(p: Palette) = LogoColors(
            ring = listOf(p.accent, lerp(p.accent, p.accent2, 0.45f), p.accent2),
            arms = listOf(p.accent2, lerp(p.accent, Color.White, 0.25f)),
            hot = lerp(Color.White, p.accent2, 0.05f),
            core = listOf(lerp(DEEP, p.accent, 0.22f), DEEP, Color(0xFF05040C)),
            glow = p.accent2,
            sparkEnd = lerp(Color.White, p.accent2, 0.35f),
        )
    }
}

private const val C = 54f
private const val RING_R = 28.5f
private const val RING_W = 4.6f
private const val THETA_MAX = 1.7 * PI

private fun armPath(phase: Double, t0: Float, t1: Float, widthScale: Float, n: Int = 24): Path {
    val pts = (0..n).map { i ->
        val t = t0 + (t1 - t0) * i / n
        val th = t * THETA_MAX
        val r = 2.5 + 36.0 * t.toDouble().pow(1.25)
        Triple((C + r * cos(th + phase)).toFloat(), (C + r * sin(th + phase)).toFloat(), t)
    }
    val left = ArrayList<Offset>(n + 1)
    val right = ArrayList<Offset>(n + 1)
    for (i in 0..n) {
        val (x, y, t) = pts[i]
        val a = pts[max(i - 1, 0)]
        val b = pts[min(i + 1, n)]
        val dx = b.first - a.first
        val dy = b.second - a.second
        val d = hypot(dx, dy).takeIf { it > 0f } ?: 1f
        val w = ((0.3 + 2.5 * sin(PI * min(t, 0.999f).toDouble().pow(0.55))) * widthScale / 2).toFloat()
        left += Offset(x - dy / d * w, y + dx / d * w)
        right += Offset(x + dy / d * w, y - dx / d * w)
    }
    return Path().apply {
        moveTo(left[0].x, left[0].y)
        for (p in left.drop(1)) lineTo(p.x, p.y)
        for (p in right.asReversed()) lineTo(p.x, p.y)
        close()
    }
}

private fun sparkPath(): Path {
    val k = 11f / 9.5f
    fun p(dx: Float, dy: Float) = Offset(C + dx * k, C + dy * k)
    return Path().apply {
        p(0f, -9.5f).let { moveTo(it.x, it.y) }
        val segs = listOf(
            listOf(p(0.9f, -3.4f), p(3.4f, -0.9f), p(9.5f, 0f)),
            listOf(p(3.4f, 0.9f), p(0.9f, 3.4f), p(0f, 9.5f)),
            listOf(p(-0.9f, 3.4f), p(-3.4f, 0.9f), p(-9.5f, 0f)),
            listOf(p(-3.4f, -0.9f), p(-0.9f, -3.4f), p(0f, -9.5f)),
        )
        for ((c1, c2, e) in segs) cubicTo(c1.x, c1.y, c2.x, c2.y, e.x, e.y)
        close()
    }
}

private val SPARK = sparkPath()

private fun DrawScope.drawLogo(colors: LogoColors, spin: Float, reach: Float, glow: Float, showRing: Boolean) {
    val center = Offset(C, C)
    val ring = Brush.linearGradient(colors.ring, start = Offset(25f, 25f), end = Offset(83f, 83f))
    if (showRing) {
        drawCircle(ring, radius = RING_R + 3.5f, center = center, alpha = 0.2f, style = Stroke(7f))
        drawCircle(Brush.radialGradient(colors.core, center, RING_R), RING_R, center)
        drawCircle(ring, radius = RING_R, center = center, style = Stroke(RING_W))
    }
    val length = reach.coerceIn(0.02f, 1f)
    rotate(spin, pivot = center) {
        for ((phase, color) in listOf(-PI / 2 to colors.arms[0], PI / 2 to colors.arms[1])) {
            // Glow: wider, faint copies of the arm.
            drawPath(armPath(phase, 0f, length, 4.2f * glow), color, alpha = (0.09f * glow).coerceAtMost(0.3f))
            drawPath(armPath(phase, 0f, length, 2.4f * glow), color, alpha = (0.26f * glow).coerceAtMost(0.6f))
            // The arm itself, coloured along its length: white-hot core, then its colour, fading tail.
            val segments = 14
            for (k in 0 until segments) {
                val t0 = k / segments.toFloat() * length
                val t1 = min(length, (k + 1.35f) / segments * length)
                val tm = (t0 + t1) / 2
                val c = lerp(colors.hot, color, min(1f, tm / 0.22f))
                val a = if (tm < 0.55f) 1f else 1f - 0.5f * (tm - 0.55f) / 0.45f
                drawPath(armPath(phase, t0, t1, 1f, 8), c, alpha = a)
            }
        }
    }
    drawCircle(
        Brush.radialGradient(listOf(colors.glow.copy(alpha = 0.6f * min(glow, 1.5f) / 1.5f + 0.2f), colors.glow.copy(alpha = 0f)), center, 13f * max(glow, 0.6f)),
        13f * max(glow, 0.6f),
        center,
    )
    rotate(spin * 0.25f, pivot = center) {
        drawPath(SPARK, Brush.radialGradient(listOf(Color.White, colors.sparkEnd), center, 11f))
    }
}

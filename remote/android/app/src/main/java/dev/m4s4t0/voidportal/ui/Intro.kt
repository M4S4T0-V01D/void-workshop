package dev.m4s4t0.voidportal.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.scale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope

/**
 * Opening animation (~1.6 s): the portal whips round fast and eases into a slow turn while its arms
 * spiral out of the spark with a flaring glow, then everything fades into the app.
 */
@Composable
fun Intro(onDone: () -> Unit) {
    val spin = remember { Animatable(-900f) }
    val reach = remember { Animatable(0.12f) }
    val glow = remember { Animatable(0.4f) }
    val zoom = remember { Animatable(0.72f) }
    val title = remember { Animatable(0f) }
    val fade = remember { Animatable(1f) }
    LaunchedEffect(Unit) {
        coroutineScope {
            listOf(
                // Fast at first, then a long, slow settle: the "quick but slow-motion" spin.
                async { spin.animateTo(0f, tween(1350, easing = CubicBezierEasing(0.08f, 0.75f, 0.12f, 1f))) },
                async { reach.animateTo(1f, tween(950, easing = FastOutSlowInEasing)) },
                async {
                    glow.animateTo(
                        1f,
                        keyframes {
                            durationMillis = 1300
                            0.4f at 0
                            1.7f at 650 using LinearEasing
                            1f at 1300 using FastOutSlowInEasing
                        },
                    )
                },
                async { zoom.animateTo(1f, tween(1100, easing = CubicBezierEasing(0.2f, 1.4f, 0.4f, 1f))) },
                async { title.animateTo(1f, tween(500, delayMillis = 550)) },
            ).awaitAll()
        }
        fade.animateTo(0f, tween(320))
        onDone()
    }
    Box(Modifier.fillMaxSize().alpha(fade.value).background(Void.bg), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            PortalLogo(Modifier.size(220.dp).scale(zoom.value), spin = spin.value, reach = reach.value, glow = glow.value)
            Spacer(Modifier.height(18.dp))
            Text("VOID Portal", color = Void.text, fontSize = 26.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.alpha(title.value))
        }
    }
}

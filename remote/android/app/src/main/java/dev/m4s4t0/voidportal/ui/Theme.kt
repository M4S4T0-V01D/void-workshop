package dev.m4s4t0.voidportal.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp

/** A colour theme; the built-in ones are generated from the desktop's themes (BuiltinThemes.kt). */
data class Palette(
    val id: String,
    val name: String,
    val light: Boolean,
    val bg: Color,
    val panel: Color,
    val panelAlt: Color,
    val border: Color,
    val text: Color,
    val dim: Color,
    val accent: Color,
    val accent2: Color,
    val ok: Color,
    val warn: Color,
    val bad: Color,
)

/**
 * The colours in use right now. Reading them from composition subscribes to theme changes, so the
 * whole app (logo and background included) recolours the moment the theme changes.
 */
object Void {
    var palette by mutableStateOf(BUILTIN_THEMES.first())
    val bg get() = palette.bg
    val panel get() = palette.panel
    val panelAlt get() = palette.panelAlt
    val border get() = palette.border
    val text get() = palette.text
    val dim get() = palette.dim
    /** Primary accent (named for the default theme's violet). */
    val violet get() = palette.accent
    /** Secondary accent (named for the default theme's cyan). */
    val cyan get() = palette.accent2
    val ok get() = palette.ok
    val warn get() = palette.warn
    val bad get() = palette.bad
    val light get() = palette.light
    fun mix(a: Color, b: Color, f: Float) = lerp(a, b, f)
}

@Composable
fun PortalTheme(content: @Composable () -> Unit) {
    val p = Void.palette
    val scheme = if (p.light) {
        lightColorScheme(
            primary = p.accent, onPrimary = Color.White, secondary = p.accent2, onSecondary = Color.White,
            primaryContainer = lerp(p.panelAlt, p.accent, 0.25f), onPrimaryContainer = p.text,
            secondaryContainer = lerp(p.panelAlt, p.accent, 0.16f), onSecondaryContainer = p.text,
            tertiary = p.accent2, onTertiary = Color.White,
            background = p.bg, onBackground = p.text, surface = p.panel, onSurface = p.text,
            surfaceVariant = p.panelAlt, onSurfaceVariant = p.dim, surfaceContainer = p.panel,
            surfaceContainerHigh = p.panelAlt, surfaceContainerHighest = p.panelAlt, outline = p.border, error = p.bad,
        )
    } else {
        darkColorScheme(
            primary = p.accent, onPrimary = Color.White, secondary = p.accent2, onSecondary = p.bg,
            // Buttons like "New task" and selected chips use the container colours: tie them to the theme too.
            primaryContainer = lerp(p.panel, p.accent, 0.75f), onPrimaryContainer = Color.White,
            secondaryContainer = lerp(p.panel, p.accent, 0.3f), onSecondaryContainer = p.text,
            tertiary = p.accent2, onTertiary = p.bg,
            background = p.bg, onBackground = p.text, surface = p.panel, onSurface = p.text,
            surfaceVariant = p.panelAlt, onSurfaceVariant = p.dim, surfaceContainer = p.panel,
            surfaceContainerHigh = p.panelAlt, surfaceContainerHighest = p.panelAlt, outline = p.border, error = p.bad,
        )
    }
    MaterialTheme(colorScheme = scheme, content = content)
}

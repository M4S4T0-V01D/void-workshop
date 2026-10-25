package dev.m4s4t0.voidportal

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.ui.graphics.Color
import dev.m4s4t0.voidportal.ui.BUILTIN_THEMES
import dev.m4s4t0.voidportal.ui.Palette
import dev.m4s4t0.voidportal.ui.Void
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * The app's colour theme: one of the desktop's built-in themes, one of the PC's own (custom or random) themes, or
 * "match my PC" (which follows the PC's current theme). Optionally switches the launcher icon to match.
 */
object Themes {
    const val MATCH_PC = "pc"
    /** Material You: colours from the phone's wallpaper (Android 12+). */
    const val WALLPAPER = "wallpaper"

    val choice = MutableStateFlow(MATCH_PC)
    val iconFollows = MutableStateFlow(true)
    private lateinit var app: Context

    private fun prefs() = app.getSharedPreferences("ui", Context.MODE_PRIVATE)

    fun init(ctx: Context) {
        app = ctx.applicationContext
        choice.value = prefs().getString("theme", MATCH_PC) ?: MATCH_PC
        iconFollows.value = prefs().getBoolean("iconFollows", true)
        apply()
    }

    fun choose(id: String) {
        choice.value = id
        prefs().edit().putString("theme", id).apply()
        apply()
    }

    fun setIconFollows(on: Boolean) {
        iconFollows.value = on
        prefs().edit().putBoolean("iconFollows", on).apply()
        apply()
    }

    /** The PC reported its theme (remote.state); remember it for when the PC is offline. */
    fun onPcState(state: JsonObject) {
        val t = state.obj("theme") ?: return
        val e = prefs().edit().putString("pcTheme", t.str("id"))
        t.obj("custom")?.let { e.putString("pcCustom", it.toString()) } ?: e.remove("pcCustom")
        // The PC's saved themes with their colours, so the phone can wear one even while the PC is offline.
        state["customThemes"]?.let { e.putString("pcThemes", it.toString()) }
        e.apply()
        if (choice.value == MATCH_PC) apply()
    }

    /** The PC's theme as last seen (a built-in id, or a custom theme's colours). */
    fun pcPalette(): Palette? {
        val id = prefs().getString("pcTheme", null) ?: return null
        BUILTIN_THEMES.firstOrNull { it.id == id }?.let { return it }
        val custom = prefs().getString("pcCustom", null) ?: return null
        return try {
            paletteFromJson(Json.parseToJsonElement(custom).jsonObject)
        } catch (e: Exception) {
            null
        }
    }

    /** The PC's own themes as last seen (empty before the first connection). */
    fun pcThemes(): List<Palette> = parsePcThemes(prefs().getString("pcThemes", null))

    /** The wallpaper's colours as a palette, light or dark like the phone; null before Android 12. */
    fun wallpaperPalette(): Palette? {
        if (Build.VERSION.SDK_INT < 31) return null
        val light = (app.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) != Configuration.UI_MODE_NIGHT_YES
        val c = if (light) dynamicLightColorScheme(app) else dynamicDarkColorScheme(app)
        return Palette(
            id = WALLPAPER,
            name = "Wallpaper",
            light = light,
            bg = c.background,
            panel = c.surfaceContainer,
            panelAlt = c.surfaceContainerHigh,
            border = c.outlineVariant,
            text = c.onSurface,
            dim = c.onSurfaceVariant,
            accent = c.primary,
            accent2 = c.tertiary,
            ok = if (light) Color(0xFF2E7D32) else Color(0xFF7BD88F),
            warn = if (light) Color(0xFFB26A00) else Color(0xFFFFC266),
            bad = c.error,
        )
    }

    /** The wallpaper or dark mode may have changed while the app was away. */
    fun refresh() {
        if (choice.value == WALLPAPER) apply()
    }

    private fun apply() {
        val p = when (val id = choice.value) {
            MATCH_PC -> pcPalette()
            WALLPAPER -> wallpaperPalette()
            else -> BUILTIN_THEMES.firstOrNull { it.id == id } ?: pcThemes().firstOrNull { it.id == id }
        } ?: BUILTIN_THEMES.first()
        val changed = Void.palette != p
        Void.palette = p
        // The home screen widget wears the same theme (drawing it calls init, so only on a real change).
        if (changed) PortalWidgetData.redraw(app)
        // Custom PC themes have no prebuilt icon; keep the default one for them.
        val iconId = if (iconFollows.value && BUILTIN_THEMES.any { it.id == p.id }) p.id else BUILTIN_THEMES.first().id
        setLauncherIcon(iconId)
    }

    /** Enable the launcher alias for [themeId] and disable the others (aliases from art/gen_icon.py). */
    private fun setLauncherIcon(themeId: String) {
        val pm = app.packageManager
        val want = ComponentName(app, "${app.packageName}.Icon_${themeId.replace('-', '_')}")
        val enabledNow = pm.getComponentEnabledSetting(want)
        val isDefault = themeId == BUILTIN_THEMES.first().id
        val alreadyOn = enabledNow == PackageManager.COMPONENT_ENABLED_STATE_ENABLED || (isDefault && enabledNow == PackageManager.COMPONENT_ENABLED_STATE_DEFAULT)
        if (alreadyOn) return
        try {
            // Turn the new one on before the old one off, so the launcher always has an entry.
            pm.setComponentEnabledSetting(want, PackageManager.COMPONENT_ENABLED_STATE_ENABLED, PackageManager.DONT_KILL_APP)
            for (t in BUILTIN_THEMES) {
                if (t.id == themeId) continue
                pm.setComponentEnabledSetting(
                    ComponentName(app, "${app.packageName}.Icon_${t.id.replace('-', '_')}"),
                    PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                    PackageManager.DONT_KILL_APP,
                )
            }
        } catch (e: Exception) {
            // Some launchers or work profiles refuse; the app keeps its current icon.
        }
    }
}

private val HEX = Regex("#[0-9a-fA-F]{6}")

/** A desktop theme ({id, name, mode, colors}) as a palette; null when a colour is missing or not #rrggbb. */
fun paletteFromJson(t: JsonObject): Palette? {
    val c = t.obj("colors") ?: return null
    fun col(k: String) = c.str(k)?.takeIf { it.matches(HEX) }?.let { Color(0xFF000000 or it.substring(1).toLong(16)) }
    return Palette(
        id = t.str("id") ?: "custom",
        name = t.str("name") ?: "Custom",
        light = t.str("mode") == "light",
        bg = col("bg") ?: return null,
        panel = col("panel") ?: return null,
        panelAlt = col("panelAlt") ?: return null,
        border = col("border") ?: return null,
        text = col("text") ?: return null,
        dim = col("textDim") ?: return null,
        accent = col("accent") ?: return null,
        accent2 = col("accent2") ?: return null,
        ok = col("success") ?: return null,
        warn = col("warning") ?: return null,
        bad = col("danger") ?: return null,
    )
}

/** The PC's customThemes list (remote.state) as palettes, skipping incomplete entries. */
fun parsePcThemes(json: String?): List<Palette> = try {
    json?.let { (Json.parseToJsonElement(it) as? JsonArray)?.mapNotNull { e -> (e as? JsonObject)?.let(::paletteFromJson) } } ?: emptyList()
} catch (e: Exception) {
    emptyList()
}

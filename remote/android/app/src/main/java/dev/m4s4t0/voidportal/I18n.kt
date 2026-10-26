package dev.m4s4t0.voidportal

import android.content.Context
import android.icu.text.PluralRules
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.text.NumberFormat
import java.util.Locale

/**
 * Interface translations, the same way VOID Workshop does them: the English text is the key,
 * `tr("Open project")`, `tr("Delete {name}?", "name" to x)`, and each language is a flat JSON file in
 * assets/i18n mapping it to the translation (a missing entry shows the English text). Plurals:
 * `trn(n, "{n} file", "{n} files")` looks up the English plural form, whose translation is a string or an
 * object keyed by plural category (one, few, many, other...). I18nTest keeps every language complete.
 */
object I18n {
    data class Language(val code: String, val name: String, val tag: String, val rtl: Boolean = false)

    /** The languages the app ships, in the order the website lists them. */
    val LANGUAGES = listOf(
        Language("en", "English", "en"),
        Language("zh", "简体中文", "zh-Hans"),
        Language("es", "Español", "es"),
        Language("ar", "العربية", "ar", rtl = true),
        Language("pt", "Português", "pt"),
        Language("fr", "Français", "fr"),
        Language("ja", "日本語", "ja"),
        Language("ru", "Русский", "ru"),
        Language("de", "Deutsch", "de"),
        Language("id", "Bahasa Indonesia", "id"),
        Language("ko", "한국어", "ko"),
        Language("tr", "Türkçe", "tr"),
        Language("hi", "हिन्दी", "hi"),
    )

    private const val PREF = "language"

    /** The saved choice: a language code, or "" to follow the phone's language. */
    var preference by mutableStateOf("")
        private set

    /** Whether the language was picked yet (the welcome screen asks once). */
    var chosen by mutableStateOf(true)
        private set

    // plurals is null only in JVM unit tests, where Android classes are stubs.
    // One state for the language and its catalog, so a Compose read of either redraws on a switch.
    private class Active(val language: Language, val catalog: JsonObject, val plurals: PluralRules?, val locale: Locale)
    private var active by mutableStateOf(Active(LANGUAGES[0], JsonObject(emptyMap()), PluralRules.forLocale(Locale.ENGLISH), Locale.ENGLISH))

    val language: Language get() = active.language
    val locale: Locale get() = active.locale

    private var app: Context? = null

    fun init(ctx: Context) {
        if (app != null) return
        app = ctx.applicationContext
        val prefs = prefs(ctx)
        chosen = prefs.contains(PREF)
        apply(prefs.getString(PREF, "") ?: "")
    }

    /** Switches the interface language; "" follows the phone. */
    fun set(ctx: Context, pref: String) {
        prefs(ctx).edit().putString(PREF, pref).apply()
        chosen = true
        apply(pref)
    }

    /** The bundled language for a preference: the preference itself, else the phone's first supported language, else English. */
    fun resolve(pref: String, system: List<Locale> = systemLocales()): Language {
        LANGUAGES.firstOrNull { it.code == pref }?.let { return it }
        for (l in system) LANGUAGES.firstOrNull { it.code == l.language.lowercase() }?.let { return it }
        return LANGUAGES[0]
    }

    private fun apply(pref: String) {
        preference = pref
        val lang = resolve(pref)
        val catalog = if (lang.code == "en") JsonObject(emptyMap()) else load(lang.code)
        val locale = Locale.forLanguageTag(lang.tag)
        active = Active(lang, catalog, PluralRules.forLocale(locale), locale)
    }

    private fun load(code: String): JsonObject = runCatching {
        val text = app!!.assets.open("i18n/$code.json").bufferedReader().use { it.readText() }
        Json.parseToJsonElement(text) as JsonObject
    }.getOrDefault(JsonObject(emptyMap()))

    private fun systemLocales(): List<Locale> {
        val list = android.content.res.Resources.getSystem().configuration.locales
        return (0 until list.size()).map { list[it] }
    }

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("ui", Context.MODE_PRIVATE)

    internal fun text(key: String): String? = (active.catalog[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }

    internal fun plural(key: String, n: Long): String? {
        val a = active
        return when (val hit = a.catalog[key]) {
            is JsonPrimitive -> hit.contentOrNull?.takeIf { it.isNotEmpty() }
            is JsonObject -> ((a.plurals?.select(n.toDouble())?.let { hit[it] } ?: hit["other"]) as? JsonPrimitive)?.contentOrNull
            else -> null
        }
    }
}

private fun fill(text: String, vars: Array<out Pair<String, Any?>>): String =
    if (vars.isEmpty()) text else Regex("\\{(\\w+)\\}").replace(text) { m -> vars.firstOrNull { it.first == m.groupValues[1] }?.second?.toString() ?: m.value }

/** Translates an English interface text, filling {placeholders} from vars. */
fun tr(text: String, vararg vars: Pair<String, Any?>): String = fill(I18n.text(text) ?: text, vars)

/** Translates a count: English picks one/other by n; translations pick their language's plural category. {n} is filled in. */
fun trn(n: Long, one: String, other: String, vararg vars: Pair<String, Any?>): String {
    val all = arrayOf("n" to NumberFormat.getIntegerInstance(I18n.locale).format(n), *vars)
    return fill(I18n.plural(other, n) ?: if (n == 1L) one else other, all)
}

fun trn(n: Int, one: String, other: String, vararg vars: Pair<String, Any?>): String = trn(n.toLong(), one, other, *vars)

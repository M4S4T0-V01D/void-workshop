package dev.m4s4t0.voidportal

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** Prompts used again and again, one tap away in the composer. Kept on the phone only. */
object Snippets {
    const val MAX = 30
    const val MAX_LENGTH = 2000

    val DEFAULTS = listOf(
        "Run the tests and fix what fails.",
        "Explain what you changed and why.",
        "Commit this with a clear message.",
        "Keep going.",
        "Review this for bugs and edge cases.",
    )

    val items = MutableStateFlow(DEFAULTS)
    private var app: Context? = null

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("ui", Context.MODE_PRIVATE)

    fun init(ctx: Context) {
        app = ctx.applicationContext
        items.value = decode(prefs(ctx).getString("snippets", null)) ?: DEFAULTS
    }

    /** Add [text] (trimmed, at most [MAX_LENGTH] chars) at the front; a duplicate moves to the front instead. */
    fun add(list: List<String>, text: String): List<String> {
        val t = text.trim().take(MAX_LENGTH)
        if (t.isEmpty()) return list
        return (listOf(t) + list.filter { it != t }).take(MAX)
    }

    fun encode(list: List<String>): String = JsonArray(list.map(::JsonPrimitive)).toString()

    /** null when nothing was saved yet (or it is unreadable), so the defaults show. */
    fun decode(json: String?): List<String>? = try {
        json?.let { (Json.parseToJsonElement(it) as? JsonArray)?.mapNotNull { e -> (e as? JsonPrimitive)?.contentOrNull?.takeIf(String::isNotBlank) } }
    } catch (e: Exception) {
        null
    }

    fun save(text: String) = set(add(items.value, text))

    fun remove(text: String) = set(items.value.filter { it != text })

    private fun set(list: List<String>) {
        items.value = list
        app?.let { prefs(it).edit().putString("snippets", encode(list)).apply() }
    }
}

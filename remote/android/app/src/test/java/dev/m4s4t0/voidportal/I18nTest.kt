package dev.m4s4t0.voidportal

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Every language catalog in assets/i18n must cover exactly the strings the sources pass to tr() and trn(). */
class I18nTest {
    private val src = File("src/main/java")
    private val catalogs = File("src/main/assets/i18n")

    private val lit = """"((?:[^"\\]|\\.)*)""""
    private val trCall = Regex("""\btr\(\s*$lit""")
    private val trnCall = Regex("""\btrn\([^,]+,\s*$lit\s*,\s*$lit""")

    private fun unescape(s: String) = Regex("""\\(.)""").replace(s) {
        when (val c = it.groupValues[1]) { "n" -> "\n"; "t" -> "\t"; else -> c }
    }

    private val sources by lazy {
        src.walkTopDown().filter { it.extension == "kt" && it.name != "I18n.kt" }.map { it.readText() }.toList()
    }
    private val texts by lazy { sources.flatMap { s -> trCall.findAll(s).map { unescape(it.groupValues[1]) } }.toSet() }
    private val plurals by lazy { sources.flatMap { s -> trnCall.findAll(s).map { unescape(it.groupValues[2]) } }.toSet() }

    /** Plural categories (CLDR, integers) each translation must give. */
    private val categories = mapOf(
        "zh" to setOf(), "ja" to setOf(), "ko" to setOf(), "id" to setOf(), "tr" to setOf(),
        "es" to setOf("one", "other"), "pt" to setOf("one", "other"), "fr" to setOf("one", "other"),
        "de" to setOf("one", "other"), "hi" to setOf("one", "other"),
        "ru" to setOf("one", "few", "many", "other"),
        "ar" to setOf("zero", "one", "two", "few", "many", "other"),
    )

    private fun placeholders(s: String) = Regex("""\{(\w+)\}""").findAll(s).map { it.groupValues[1] }.toSet()

    private fun catalog(code: String) = Json.parseToJsonElement(File(catalogs, "$code.json").readText()).jsonObject

    @Test
    fun sourcesUseLiteralKeysWithoutTemplates() {
        assertTrue("found no tr() calls", texts.size > 300)
        val templated = (texts + plurals).filter { '$' in it }
        assertTrue("string templates inside tr keys: $templated", templated.isEmpty())
    }

    @Test
    fun everyLanguageShipsACatalog() {
        val codes = I18n.LANGUAGES.map { it.code }.filter { it != "en" }.toSet()
        assertEquals(codes, categories.keys)
        assertEquals(codes, catalogs.listFiles()!!.map { it.nameWithoutExtension }.toSet())
    }

    @Test
    fun catalogsAreCompleteAndCurrent() {
        val wanted = texts + plurals
        for (code in categories.keys) {
            val keys = catalog(code).keys
            assertEquals("$code missing", emptySet<String>(), wanted - keys)
            assertEquals("$code stale", emptySet<String>(), keys - wanted)
        }
    }

    @Test
    fun translationsKeepPlaceholdersAndPluralForms() {
        for ((code, needed) in categories) {
            for ((key, value) in catalog(code)) {
                val forms = when (value) {
                    is JsonPrimitive -> {
                        if (key in plurals) assertTrue("$code '$key' needs plural forms $needed", needed.isEmpty())
                        listOf(value.content)
                    }
                    is JsonObject -> {
                        assertTrue("$code '$key' is not a plural", key in plurals)
                        assertEquals("$code '$key' plural forms", needed, value.keys)
                        value.values.map { (it as JsonPrimitive).content }
                    }
                    else -> error("$code '$key' has an unexpected value")
                }
                for (f in forms) {
                    assertTrue("$code '$key' is empty", f.isNotBlank())
                    assertEquals("$code '$key' placeholders in '$f'", placeholders(key), placeholders(f))
                }
            }
        }
    }
}

package dev.m4s4t0.voidportal

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ThemesTest {
    private val colors = """{"bg":"#0b0a12","panel":"#121020","panelAlt":"#1a1730","border":"#2a2546","text":"#e8e4ff","textDim":"#9a93c0",
        "accent":"#ff5fd2","accent2":"#22e3ff","success":"#3ee08f","warning":"#ffc857","danger":"#ff5c7a"}"""

    @Test
    fun parsesThePcsThemesWithTheirColours() {
        val list = parsePcThemes("""[{"id":"custom-silent-orbit","name":"Silent Orbit","mode":"light","colors":$colors}]""")
        assertEquals(1, list.size)
        val p = list[0]
        assertEquals("custom-silent-orbit", p.id)
        assertEquals("Silent Orbit", p.name)
        assertTrue(p.light)
        assertEquals(Color(0xFFFF5FD2), p.accent)
    }

    @Test
    fun skipsIncompleteOrBadEntries() {
        val bad = colors.replace("#ff5fd2", "pink")
        val list = parsePcThemes("""[{"id":"a","name":"Only id"},{"id":"b","name":"Bad","colors":$bad},{"id":"c","name":"Ok","colors":$colors}]""")
        assertEquals(listOf("c"), list.map { it.id })
    }

    @Test
    fun toleratesMissingOrBrokenJson() {
        assertTrue(parsePcThemes(null).isEmpty())
        assertTrue(parsePcThemes("not json").isEmpty())
        assertTrue(parsePcThemes("{}").isEmpty())
        assertNull(paletteFromJson(kotlinx.serialization.json.buildJsonObject {}))
    }
}

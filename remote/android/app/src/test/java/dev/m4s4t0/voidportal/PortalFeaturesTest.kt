package dev.m4s4t0.voidportal

import dev.m4s4t0.voidportal.ui.commitMessageFrom
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PortalFeaturesTest {
    private fun todo(status: String, subject: String, description: String = ""): JsonObject =
        Json.parseToJsonElement("""{"subject":"$subject","description":"$description","status":"$status"}""").jsonObject

    @Test
    fun liveProgressCountsTheTodoListAndNamesTheCurrentStep() {
        val p = todoProgress(listOf(todo("completed", "Read"), todo("in_progress", "Write tests", "Writing tests"), todo("pending", "Ship")))
        assertEquals(TodoProgress(done = 1, total = 3, current = "Writing tests"), p)
        // Without an activeForm the subject is used; with nothing in progress there is no current step.
        assertEquals("Ship", todoProgress(listOf(todo("in_progress", "Ship"))).current)
        assertNull(todoProgress(listOf(todo("completed", "Done"))).current)
        assertEquals(TodoProgress(0, 0, null), todoProgress(emptyList()))
    }

    @Test
    fun snippetsGoToTheFrontWithoutDuplicatesAndSurviveARoundTrip() {
        var list = Snippets.add(listOf("a", "b"), "  b ")
        assertEquals(listOf("b", "a"), list)
        list = Snippets.add(list, "   ")
        assertEquals(listOf("b", "a"), list)
        val many = (1..40).fold(emptyList<String>()) { acc, i -> Snippets.add(acc, "s$i") }
        assertEquals(Snippets.MAX, many.size)
        assertEquals("s40", many.first())
        assertEquals(Snippets.MAX_LENGTH, Snippets.add(emptyList(), "x".repeat(5000)).first().length)
        val quoted = listOf("say \"hi\"\nthen go", "ünïcode")
        assertEquals(quoted, Snippets.decode(Snippets.encode(quoted)))
        assertNull(Snippets.decode(null))
        assertNull(Snippets.decode("not json"))
        assertEquals(emptyList<String>(), Snippets.decode("[]"))
    }

    @Test
    fun sharedPicturesShrinkToTheLongestSideKeepingTheirShape() {
        assertEquals(1600 to 1200, SharedImages.fit(4000, 3000, 1600))
        assertEquals(900 to 1600, SharedImages.fit(2700, 4800, 1600))
        assertEquals(800 to 600, SharedImages.fit(800, 600, 1600))
        assertEquals(1600 to 1, SharedImages.fit(16000, 2, 1600))
        // Subsampling never goes below the target size.
        assertEquals(2, SharedImages.sampleSize(4000, 3000, 1600))
        assertEquals(1, SharedImages.sampleSize(3000, 2000, 1600))
        assertEquals(4, SharedImages.sampleSize(8000, 6000, 1600))
        assertTrue(SharedImages.MAX_BYTES * 4 / 3 * 4 / 3 < 1024 * 1024)
    }

    @Test
    fun tileSaysWhatRunsAndWhatWaits() {
        assertEquals("Not paired", tileSubtitle(false, true, 3, 1))
        assertEquals("PC offline", tileSubtitle(true, false, 3, 1))
        assertEquals("Nothing running", tileSubtitle(true, true, 0, 0))
        assertEquals("2 running · 1 needs you", tileSubtitle(true, true, 2, 1))
        assertEquals("3 need you", tileSubtitle(true, true, 0, 3))
    }

    @Test
    fun commitMessagesComeFromTheTaskTitle() {
        assertEquals("Add a login form", commitMessageFrom("Add a login form."))
        assertEquals("First line", commitMessageFrom("First line\nmore"))
        assertEquals("", commitMessageFrom(null))
        val long = commitMessageFrom("word ".repeat(30))
        assertTrue(long.length <= 72 && long.endsWith("…"))
    }
}

package dev.m4s4t0.voidportal

import dev.m4s4t0.voidportal.ui.jumpDown
import dev.m4s4t0.voidportal.ui.jumpUp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TimelineJumpTest {
    private val messages = listOf(0, 3, 7)

    @Test
    fun upGoesToThePreviousMessage() {
        assertEquals(3, jumpUp(messages, first = 5, offset = 0))
        assertEquals(3, jumpUp(messages, first = 7, offset = 0))
        assertNull(jumpUp(messages, first = 0, offset = 0))
    }

    @Test
    fun upGoesToTheStartOfAMessageScrolledInto() {
        assertEquals(7, jumpUp(messages, first = 7, offset = 120))
        assertEquals(0, jumpUp(messages, first = 0, offset = 40))
    }

    @Test
    fun downGoesToTheNextMessage() {
        assertEquals(3, jumpDown(messages, first = 0))
        assertEquals(7, jumpDown(messages, first = 4))
        assertNull(jumpDown(messages, first = 7))
    }
}

package dev.m4s4t0.voidportal

import java.io.File
import java.util.Base64
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class PortalCryptoTest {
    // The same vector the PC side checks (sidecar/test/remote.test.ts).
    private val v = Json.parseToJsonElement(File("../../test-vectors.json").readText()).jsonObject
    private fun s(k: String) = v[k]!!.jsonPrimitive.content
    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    @Test
    fun derivesTheSameKeysAsThePc() {
        val keys = PortalCrypto.derive(Base64.getUrlDecoder().decode(s("secret")))
        assertEquals(s("channelId"), keys.channelId)
        assertEquals(s("token"), keys.token)
        assertEquals(s("hostToPhone"), hex(keys.hostToPhone))
        assertEquals(s("phoneToHost"), hex(keys.phoneToHost))
    }

    @Test
    fun opensAFrameSealedByThePc() {
        val keys = PortalCrypto.derive(Base64.getUrlDecoder().decode(s("secret")))
        val sample = v["sample"]!!.jsonObject
        assertEquals(sample["plaintext"]!!.jsonPrimitive.content, PortalCrypto.open(keys, "h2p", sample["frame"]!!.jsonPrimitive.content))
        // And sealing with the same nonce gives the PC's exact bytes.
        assertEquals(sample["frame"]!!.jsonPrimitive.content, PortalCrypto.seal(keys, "h2p", sample["plaintext"]!!.jsonPrimitive.content, ByteArray(12) { 7 }))
    }

    @Test
    fun rejectsTheWrongDirectionOrATamperedFrame() {
        val keys = PortalCrypto.derive(ByteArray(32) { 1 })
        val frame = PortalCrypto.seal(keys, "p2h", "{\"a\":1}")
        assertEquals("{\"a\":1}", PortalCrypto.open(keys, "p2h", frame))
        assertThrows(Exception::class.java) { PortalCrypto.open(keys, "h2p", frame) }
        val raw = Base64.getUrlDecoder().decode(frame)
        raw[14] = (raw[14].toInt() xor 1).toByte()
        assertThrows(Exception::class.java) { PortalCrypto.open(keys, "p2h", PortalCrypto.b64url(raw)) }
    }

    @Test
    fun parsesTheShortPairingCode() {
        val p = Pairing.parse("VOIDPORTAL://P/${s("secretBase32")}/VOID-RELAY.SOMEONE.WORKERS.DEV")
        assertEquals("wss://void-relay.someone.workers.dev", p.relayUrl)
        assertEquals(s("channelId"), p.keys.channelId)
        // Scanners sometimes hand back lower case.
        assertEquals(s("channelId"), Pairing.parse("voidportal://p/${s("secretBase32").lowercase()}/relay.example.dev:8443").keys.channelId)
        assertThrows(IllegalArgumentException::class.java) { Pairing.parse("VOIDPORTAL://P/TOOSHORT/RELAY.EXAMPLE.DEV") }
        // No relay host: there is no built-in relay to fall back to.
        assertThrows(IllegalArgumentException::class.java) { Pairing.parse("VOIDPORTAL://P/${s("secretBase32")}") }
    }

    @Test
    fun parsesAPairingLink() {
        val secret = PortalCrypto.b64url(ByteArray(32) { it.toByte() })
        val p = Pairing.parse("voidportal://pair?v=1&r=wss%3A%2F%2Fvoid-relay.example.dev&s=$secret&n=desk-pc")
        assertEquals("wss://void-relay.example.dev", p.relayUrl)
        assertEquals("desk-pc", p.pcName)
        assertEquals(s("channelId"), p.keys.channelId)
        assertThrows(IllegalArgumentException::class.java) { Pairing.parse("https://evil.example") }
        assertThrows(IllegalArgumentException::class.java) { Pairing.parse("voidportal://pair?v=1&r=ws%3A%2F%2Fplain&s=$secret") }
    }
}

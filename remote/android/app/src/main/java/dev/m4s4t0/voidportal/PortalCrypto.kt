package dev.m4s4t0.voidportal

import java.io.ByteArrayOutputStream
import java.net.URLDecoder
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * End-to-end encryption shared with VOID Workshop (remote/PROTOCOL.md): HKDF-SHA256 from the 32-byte
 * pairing secret, AES-256-GCM per direction. Must stay byte-compatible with sidecar/src/remoteCrypto.ts.
 */
object PortalCrypto {
    class Keys(val channelId: String, val token: String, val hostToPhone: ByteArray, val phoneToHost: ByteArray)

    private const val SALT = "void-remote-v1"
    private val random = SecureRandom()

    fun hkdf(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        mac.init(SecretKeySpec(prk, "HmacSHA256"))
        val out = ByteArrayOutputStream()
        var block = ByteArray(0)
        var counter = 1
        while (out.size() < length) {
            mac.update(block)
            mac.update(info)
            mac.update(counter.toByte())
            block = mac.doFinal()
            out.write(block)
            counter++
        }
        return out.toByteArray().copyOf(length)
    }

    fun derive(secret: ByteArray): Keys {
        require(secret.size == 32) { "The pairing secret must be 32 bytes" }
        val salt = SALT.toByteArray()
        fun okm(info: String, len: Int) = hkdf(secret, salt, info.toByteArray(), len)
        return Keys(
            channelId = okm("channel", 16).joinToString("") { "%02x".format(it) },
            token = b64url(okm("token", 32)),
            hostToPhone = okm("host->phone", 32),
            phoneToHost = okm("phone->host", 32),
        )
    }

    /** base64url(nonce ‖ ciphertext ‖ tag), AAD "<channel>:<dir>". */
    fun seal(keys: Keys, dir: String, plaintext: String, nonce: ByteArray = ByteArray(12).also { random.nextBytes(it) }): String {
        val key = if (dir == "h2p") keys.hostToPhone else keys.phoneToHost
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD("${keys.channelId}:$dir".toByteArray())
        return b64url(nonce + cipher.doFinal(plaintext.toByteArray()))
    }

    /** Throws when the frame was not sealed with this channel's key for that direction. */
    fun open(keys: Keys, dir: String, frame: String): String {
        val raw = Base64.getUrlDecoder().decode(frame)
        require(raw.size >= 28) { "Frame too short" }
        val key = if (dir == "h2p") keys.hostToPhone else keys.phoneToHost
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, raw, 0, 12))
        cipher.updateAAD("${keys.channelId}:$dir".toByteArray())
        return String(cipher.doFinal(raw, 12, raw.size - 12))
    }

    fun b64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
}

/**
 * What the QR code on the PC carries. With the default relay: VOIDPORTAL://P/<secret, base32> (short and
 * upper case, so the QR code is coarse and easy to scan). With another relay:
 * voidportal://pair?v=1&r=<relay>&s=<secret, base64url>&n=<pc name>.
 */
data class Pairing(val relayUrl: String, val secret: ByteArray, val pcName: String) {
    val keys: PortalCrypto.Keys by lazy { PortalCrypto.derive(secret) }

    companion object {
        private const val B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        // VOIDPORTAL://P/<secret, base32>/<relay host>: upper case so QR can use its compact alphanumeric mode.
        private val SHORT = Regex("^voidportal://p/([A-Z2-7]{52})/([A-Z0-9.-]+(?::[0-9]+)?)$", RegexOption.IGNORE_CASE)

        fun unbase32(text: String): ByteArray {
            var bits = 0
            var value = 0
            val out = java.io.ByteArrayOutputStream()
            for (ch in text.uppercase()) {
                val v = B32.indexOf(ch)
                require(v >= 0) { tr("The pairing code is damaged.") }
                value = (value shl 5) or v
                bits += 5
                if (bits >= 8) {
                    out.write((value ushr (bits - 8)) and 255)
                    bits -= 8
                }
            }
            return out.toByteArray()
        }

        fun parse(link: String): Pairing {
            val trimmed = link.trim()
            SHORT.matchEntire(trimmed)?.let { m ->
                val secret = unbase32(m.groupValues[1])
                require(secret.size == 32) { tr("The pairing code is damaged.") }
                return Pairing("wss://" + m.groupValues[2].lowercase(), secret, "PC")
            }
            require(trimmed.startsWith("voidportal://pair?")) { tr("That is not a VOID Portal pairing code.") }
            val q = trimmed.substringAfter('?').split('&').mapNotNull {
                val i = it.indexOf('=')
                if (i <= 0) null else URLDecoder.decode(it.substring(0, i), "UTF-8") to URLDecoder.decode(it.substring(i + 1), "UTF-8")
            }.toMap()
            require(q["v"] == "1") { tr("This pairing code is from a newer VOID Workshop. Update VOID Portal.") }
            val relay = q["r"] ?: ""
            require(relay.startsWith("wss://")) { tr("The pairing code has no secure relay address.") }
            val secret = Base64.getUrlDecoder().decode(q["s"] ?: "")
            require(secret.size == 32) { tr("The pairing code is damaged.") }
            return Pairing(relay.trimEnd('/'), secret, (q["n"] ?: "PC").take(60))
        }
    }
}

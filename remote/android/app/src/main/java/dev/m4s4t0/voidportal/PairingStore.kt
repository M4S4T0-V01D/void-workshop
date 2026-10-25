package dev.m4s4t0.voidportal

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Keeps the pairing; the secret is encrypted with a key that never leaves the Android Keystore. */
class PairingStore(context: Context) {
    private val prefs = context.getSharedPreferences("pairing", Context.MODE_PRIVATE)

    fun load(): Pairing? {
        val enc = prefs.getString("secret", null) ?: return null
        val relay = prefs.getString("relay", null) ?: return null
        return try {
            Pairing(relay, decrypt(enc), prefs.getString("pc", "PC") ?: "PC")
        } catch (e: Exception) {
            null
        }
    }

    fun save(p: Pairing) {
        prefs.edit().putString("relay", p.relayUrl).putString("pc", p.pcName).putString("secret", encrypt(p.secret)).apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private fun encrypt(data: ByteArray): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        return Base64.getEncoder().encodeToString(c.iv + c.doFinal(data))
    }

    private fun decrypt(text: String): ByteArray {
        val raw = Base64.getDecoder().decode(text)
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12))
        return c.doFinal(raw, 12, raw.size - 12)
    }

    private companion object {
        const val ALIAS = "voidportal-pairing"
    }
}

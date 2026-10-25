package dev.m4s4t0.voidportal

import android.graphics.BitmapFactory
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The scanner's detector on simulated phone photos of the pairing code on a monitor (blur, tilt,
 * perspective, glare, moiré, JPEG; made by remote/android/art/gen_qr_photos.py). Every photo of the current
 * short code must decode, then pair.
 */
@RunWith(AndroidJUnit4::class)
class QrDecodeTest {
    private val ctx = InstrumentationRegistry.getInstrumentation().context
    private val scanner = BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())

    private fun decode(name: String): String? {
        val bmp = ctx.assets.open("$name.jpg").use(BitmapFactory::decodeStream)
        return Tasks.await(scanner.process(InputImage.fromBitmap(bmp, 0))).firstOrNull()?.rawValue
    }

    private fun expected(kind: String) = ctx.assets.open("expected_$kind.txt").bufferedReader().readText().trim()

    private val cases = listOf("easy", "far", "tilted", "soft", "glare")

    @Test
    fun readsTheShortPairingCodeInEveryPhoto() {
        val want = expected("short")
        for (c in cases) {
            val got = decode("short_$c")
            assertEquals("short_$c", want, got)
            Pairing.parse(got!!) // and it is a valid pairing
        }
    }

    @Test
    fun reportsHowTheOldLongCodeFares() {
        val want = expected("long")
        val read = cases.count { decode("long_$it") == want }
        println("QRDECODE old long code: $read/${cases.size} photos decoded")
    }
}

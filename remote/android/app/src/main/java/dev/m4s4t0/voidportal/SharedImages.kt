package dev.m4s4t0.voidportal

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.util.Base64
import java.io.ByteArrayOutputStream
import kotlin.math.max
import kotlin.math.roundToInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/** Pictures shared to the Portal, made small enough for one relay frame and uploaded to the PC (image.upload). */
object SharedImages {
    /** The PC refuses uploads over 512 KiB (sidecar MAX_UPLOAD_BYTES). */
    const val MAX_BYTES = 512 * 1024
    const val MAX_SIDE = 1600
    /** At most this many go with one message (sidecar MAX_ATTACHMENTS). */
    const val MAX_PICTURES = 4
    private val QUALITIES = listOf(82, 70, 58, 45)

    /** [w]×[h] scaled down (never up) so the longer side is at most [maxSide]. */
    fun fit(w: Int, h: Int, maxSide: Int): Pair<Int, Int> {
        val longest = max(w, h)
        if (longest <= maxSide || longest <= 0) return w to h
        val s = maxSide.toDouble() / longest
        return max(1, (w * s).roundToInt()) to max(1, (h * s).roundToInt())
    }

    /** Power-of-two subsampling that keeps the picture at least [maxSide] on its longer side (BitmapFactory). */
    fun sampleSize(w: Int, h: Int, maxSide: Int): Int {
        var n = 1
        while (max(w, h) / (n * 2) >= maxSide) n *= 2
        return n
    }

    private fun decode(ctx: Context, uri: Uri, maxSide: Int): Bitmap? = try {
        if (Build.VERSION.SDK_INT >= 28) {
            // ImageDecoder also turns camera photos upright (EXIF orientation).
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(ctx.contentResolver, uri)) { d, info, _ ->
                val (w, h) = fit(info.size.width, info.size.height, maxSide)
                d.setTargetSize(w, h)
                d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
        } else {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            ctx.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
            val opts = BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, maxSide) }
            ctx.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) }?.let { b ->
                val (w, h) = fit(b.width, b.height, maxSide)
                if (w == b.width && h == b.height) b else Bitmap.createScaledBitmap(b, w, h, true)
            }
        }
    } catch (e: Exception) {
        null
    }

    /** JPEG of [bmp] (transparency over white), lowering quality and then size until it fits [MAX_BYTES]. */
    private fun jpeg(bmp: Bitmap): ByteArray? {
        var b = bmp
        if (b.hasAlpha()) {
            val flat = Bitmap.createBitmap(b.width, b.height, Bitmap.Config.ARGB_8888)
            Canvas(flat).apply { drawColor(android.graphics.Color.WHITE); drawBitmap(b, 0f, 0f, null) }
            b = flat
        }
        repeat(4) {
            for (q in QUALITIES) {
                val out = ByteArrayOutputStream()
                b.compress(Bitmap.CompressFormat.JPEG, q, out)
                if (out.size() <= MAX_BYTES) return out.toByteArray()
            }
            val (w, h) = fit(b.width, b.height, (max(b.width, b.height) * 0.7).roundToInt())
            b = Bitmap.createScaledBitmap(b, w, h, true)
        }
        return null
    }

    /** A small preview for the share screen. */
    suspend fun thumbnail(ctx: Context, uri: Uri): Bitmap? = withContext(Dispatchers.IO) { decode(ctx, uri, 320) }

    /** Shrink, upload and return the PC's id for it. */
    suspend fun upload(ctx: Context, uri: Uri): String {
        val bytes = withContext(Dispatchers.IO) { decode(ctx, uri, MAX_SIDE)?.let(::jpeg) }
            ?: throw PortalError("not-image", "That picture could not be read.")
        val res = Portal.call("image.upload", json("data" to Base64.encodeToString(bytes, Base64.NO_WRAP)), timeoutMs = 90_000) as? JsonObject
        return res?.str("imageId") ?: throw PortalError("upload", "The PC did not take the picture.")
    }
}

package dev.m4s4t0.voidportal.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Image
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import dev.m4s4t0.voidportal.Portal
import dev.m4s4t0.voidportal.PortalError
import dev.m4s4t0.voidportal.bool
import dev.m4s4t0.voidportal.json
import dev.m4s4t0.voidportal.str
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import dev.m4s4t0.voidportal.tr

/** Pictures already fetched this run, so scrolling back does not download them again. */
private object ImageCache : LruCache<String, Bitmap>(48 * 1024 * 1024) {
    override fun sizeOf(key: String, value: Bitmap) = value.allocationByteCount
}

/** Fetch a kept image from the PC piece by piece (each reply fits a relay frame). */
private suspend fun fetchImage(taskId: String, imageId: String): Bitmap {
    val out = ByteArrayOutputStream()
    while (true) {
        val c = Portal.call("task.image", json("taskId" to taskId, "imageId" to imageId, "offset" to out.size())) as JsonObject
        val part = Base64.decode(c.str("data") ?: "", Base64.DEFAULT)
        out.write(part)
        if (c.bool("done") == true || part.isEmpty()) break
    }
    val bytes = out.toByteArray()
    return withContext(Dispatchers.Default) {
        // Phone screenshots can be large; decode at most ~2048 px on the long side.
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 2048) sample *= 2
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: throw PortalError("image", tr("That image could not be shown."))
    }
}

private fun sizeText(bytes: Double): String =
    if (bytes >= 1024 * 1024) "%.1f MB".format(bytes / 1024 / 1024) else "${maxOf(1, (bytes / 1024).toInt())} KB"

/** A screenshot the agent looked at: nothing is downloaded until Load is tapped, so the chat stays quick. */
@Composable
fun ImageRow(taskId: String, item: TImage) {
    var bitmap by remember(item.imageId) { mutableStateOf(ImageCache.get(item.imageId)) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var full by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(Void.panel).padding(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Image, null, tint = Void.cyan, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            Text(item.name, fontSize = 13.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(sizeText(item.bytes), color = Void.dim, fontSize = 12.sp)
        }
        val bmp = bitmap
        when {
            bmp != null -> Image(
                bmp.asImageBitmap(),
                item.name,
                contentScale = ContentScale.Fit,
                modifier = Modifier.padding(top = 6.dp).fillMaxWidth().heightIn(max = 420.dp).clip(RoundedCornerShape(6.dp)).clickable { full = true },
            )
            loading -> CircularProgressIndicator(Modifier.padding(top = 8.dp).size(22.dp), strokeWidth = 2.dp)
            else -> {
                OutlinedButton(
                    onClick = {
                        loading = true
                        error = null
                        scope.launch {
                            try {
                                val b = fetchImage(taskId, item.imageId)
                                ImageCache.put(item.imageId, b)
                                bitmap = b
                            } catch (e: PortalError) {
                                error = e.message
                            } catch (e: Exception) {
                                error = tr("Could not load the image.")
                            } finally {
                                loading = false
                            }
                        }
                    },
                    modifier = Modifier.padding(top = 6.dp),
                ) { Text(if (error != null) tr("Try again") else tr("Load image")) }
                error?.let { Text(it, color = Void.bad, fontSize = 12.sp) }
            }
        }
    }
    val bmp = bitmap
    if (full && bmp != null) FullImage(bmp, item.name) { full = false }
}

/** Full screen, pinch to zoom and drag; tap to close. */
@Composable
private fun FullImage(bitmap: Bitmap, name: String, onClose: () -> Unit) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black)
                .pointerInput(Unit) {
                    detectTransformGestures { _, pan, zoom, _ ->
                        scale = (scale * zoom).coerceIn(1f, 8f)
                        offset = if (scale == 1f) Offset.Zero else offset + pan
                    }
                }
                .clickable(onClick = onClose),
            contentAlignment = Alignment.Center,
        ) {
            Image(
                bitmap.asImageBitmap(),
                name,
                contentScale = ContentScale.Fit,
                modifier = Modifier.fillMaxSize().graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                    translationX = offset.x
                    translationY = offset.y
                },
            )
        }
    }
}

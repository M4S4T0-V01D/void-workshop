package dev.m4s4t0.voidportal.ui

import android.Manifest
import android.content.pm.PackageManager
import android.util.Size
import android.view.MotionEvent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.FlashlightOff
import androidx.compose.material.icons.filled.FlashlightOn
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size as GSize
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** True for anything that looks like a VOID Portal pairing code (short or long form). */
fun isPairingCode(text: String) = text.trim().lowercase().startsWith("voidportal://")

/**
 * Full-screen QR scanner: CameraX preview with continuous autofocus (tap to focus), torch, and the
 * bundled ML Kit barcode model. Calls [onResult] once with the first VOID Portal code it sees.
 */
@Composable
fun QrScanner(onResult: (String) -> Unit, onClose: () -> Unit) {
    val ctx = LocalContext.current
    var granted by remember { mutableStateOf(ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    BackHandler(onBack = onClose)
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        if (granted) CameraPreview(onResult) else {
            Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                Text("VOID Portal needs the camera to scan the pairing code on your PC.", textAlign = TextAlign.Center, color = Void.text)
                Spacer(Modifier.height(16.dp))
                Button(onClick = { ask.launch(Manifest.permission.CAMERA) }) { Text("Allow camera") }
            }
            androidx.compose.runtime.LaunchedEffect(Unit) { ask.launch(Manifest.permission.CAMERA) }
        }
        IconButton(onClick = onClose, modifier = Modifier.systemBarsPadding().padding(8.dp).align(Alignment.TopStart)) {
            Icon(Icons.Default.Close, "Close", tint = Color.White)
        }
    }
}

@androidx.annotation.OptIn(ExperimentalGetImage::class)
@Composable
private fun CameraPreview(onResult: (String) -> Unit) {
    val ctx = LocalContext.current
    val owner = LocalLifecycleOwner.current
    var camera by remember { mutableStateOf<Camera?>(null) }
    var torch by remember { mutableStateOf(false) }
    var hint by remember { mutableStateOf("Point the camera at the code in VOID Workshop") }
    val done = remember { AtomicBoolean(false) }
    val executor = remember { Executors.newSingleThreadExecutor() }
    val scanner = remember { BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build()) }
    DisposableEffect(Unit) {
        onDispose {
            scanner.close()
            executor.shutdown()
        }
    }

    AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { c ->
            val view = PreviewView(c).apply { scaleType = PreviewView.ScaleType.FILL_CENTER }
            val future = ProcessCameraProvider.getInstance(c)
            future.addListener({
                val provider = future.get()
                val preview = Preview.Builder().build().also { it.surfaceProvider = view.surfaceProvider }
                val analysis = ImageAnalysis.Builder()
                    .setResolutionSelector(ResolutionSelector.Builder().setResolutionStrategy(ResolutionStrategy(Size(1280, 960), ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER)).build())
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                analysis.setAnalyzer(executor) { proxy ->
                    val media = proxy.image
                    if (media == null || done.get()) {
                        proxy.close()
                        return@setAnalyzer
                    }
                    scanner.process(InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees))
                        .addOnSuccessListener { codes ->
                            val raw = codes.firstNotNullOfOrNull { it.rawValue }
                            when {
                                raw == null -> Unit
                                isPairingCode(raw) -> if (done.compareAndSet(false, true)) onResult(raw.trim())
                                else -> hint = "That QR code isn't a VOID Portal pairing code"
                            }
                        }
                        .addOnCompleteListener { proxy.close() }
                }
                try {
                    provider.unbindAll()
                    camera = provider.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                } catch (e: Exception) {
                    hint = "Could not start the camera: ${e.message}"
                }
            }, ContextCompat.getMainExecutor(c))
            // Tap to focus.
            view.setOnTouchListener { v, ev ->
                if (ev.action == MotionEvent.ACTION_UP) {
                    val point = view.meteringPointFactory.createPoint(ev.x, ev.y)
                    camera?.cameraControl?.startFocusAndMetering(FocusMeteringAction.Builder(point).build())
                    v.performClick()
                }
                true
            }
            view
        },
    )
    Viewfinder()
    Column(Modifier.fillMaxSize().systemBarsPadding().padding(24.dp), verticalArrangement = Arrangement.Bottom, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(hint, color = Color.White, fontSize = 15.sp, textAlign = TextAlign.Center)
        Text("Tap to focus · hold 20–30 cm from the screen", color = Color.White.copy(alpha = 0.7f), fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
        Row(Modifier.fillMaxWidth().padding(top = 12.dp), horizontalArrangement = Arrangement.Center) {
            if (camera?.cameraInfo?.hasFlashUnit() == true) {
                IconButton(onClick = {
                    torch = !torch
                    camera?.cameraControl?.enableTorch(torch)
                }) { Icon(if (torch) Icons.Default.FlashlightOn else Icons.Default.FlashlightOff, "Torch", tint = Color.White) }
            }
        }
    }
}

/** Dimmed surround with a clear square and glowing violet/cyan corners, and a scan line sweeping through. */
@Composable
private fun Viewfinder() {
    val t = rememberInfiniteTransition(label = "scan")
    val sweep by t.animateFloat(0f, 1f, infiniteRepeatable(tween(1800, easing = LinearEasing), RepeatMode.Reverse), label = "sweep")
    Canvas(Modifier.fillMaxSize()) {
        val side = size.minDimension * 0.72f
        val tl = Offset((size.width - side) / 2, (size.height - side) / 2.4f)
        // Dim everything but the window: one even-odd path (outer rect with a rounded hole).
        val dim = Path().apply {
            fillType = PathFillType.EvenOdd
            addRect(Rect(Offset.Zero, size))
            addRoundRect(RoundRect(Rect(tl, GSize(side, side)), androidx.compose.ui.geometry.CornerRadius(28f)))
        }
        drawPath(dim, Color.Black.copy(alpha = 0.55f))
        val len = side * 0.16f
        val corners = listOf(
            Triple(tl, Offset(len, 0f), Offset(0f, len)),
            Triple(Offset(tl.x + side, tl.y), Offset(-len, 0f), Offset(0f, len)),
            Triple(Offset(tl.x, tl.y + side), Offset(len, 0f), Offset(0f, -len)),
            Triple(Offset(tl.x + side, tl.y + side), Offset(-len, 0f), Offset(0f, -len)),
        )
        for ((i, c) in corners.withIndex()) {
            val color = if (i % 2 == 0) Void.violet else Void.cyan
            val (p, h, v) = c
            for ((w, a) in listOf(18f to 0.18f, 6f to 1f)) {
                drawLine(color.copy(alpha = a), p, p + h, strokeWidth = w, cap = StrokeCap.Round)
                drawLine(color.copy(alpha = a), p, p + v, strokeWidth = w, cap = StrokeCap.Round)
            }
        }
        val y = tl.y + side * (0.08f + 0.84f * sweep)
        drawLine(Void.cyan.copy(alpha = 0.25f), Offset(tl.x + 24f, y), Offset(tl.x + side - 24f, y), strokeWidth = 10f, cap = StrokeCap.Round)
        drawLine(Void.cyan, Offset(tl.x + 24f, y), Offset(tl.x + side - 24f, y), strokeWidth = 2.5f, cap = StrokeCap.Round)
        drawRoundRect(Color.White.copy(alpha = 0.08f), tl, GSize(side, side), androidx.compose.ui.geometry.CornerRadius(28f), style = Stroke(2f))
    }
}

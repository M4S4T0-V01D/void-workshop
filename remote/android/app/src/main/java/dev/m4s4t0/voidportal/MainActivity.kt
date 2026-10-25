package dev.m4s4t0.voidportal

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import android.graphics.Color as AndroidColor
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import dev.m4s4t0.voidportal.ui.ApprovalSheet
import dev.m4s4t0.voidportal.ui.CosmicBackground
import dev.m4s4t0.voidportal.ui.HomeScreen
import dev.m4s4t0.voidportal.ui.Intro
import dev.m4s4t0.voidportal.ui.NewTaskScreen
import dev.m4s4t0.voidportal.ui.PairScreen
import dev.m4s4t0.voidportal.ui.PcSettingsScreen
import dev.m4s4t0.voidportal.ui.PortalTheme
import dev.m4s4t0.voidportal.ui.SettingsScreen
import dev.m4s4t0.voidportal.ui.ShareScreen
import dev.m4s4t0.voidportal.ui.TaskScreen
import dev.m4s4t0.voidportal.ui.Void
import dev.m4s4t0.voidportal.ui.tryPair

sealed interface Screen {
    data object Home : Screen
    data object NewTask : Screen
    data object Settings : Screen
    data object PcSettings : Screen
    data class Task(val id: String) : Screen
    /** Text and pictures shared from another app. */
    data class Share(val text: String, val uris: List<Uri>) : Screen
}

class MainActivity : ComponentActivity() {
    private var screen by mutableStateOf<Screen>(Screen.Home)
    private var approval by mutableStateOf<String?>(null)
    private var pairError by mutableStateOf<String?>(null)
    private var intro by mutableStateOf(true)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        Portal.init(this)
        Themes.init(this)
        Ambience.init(this)
        UiSounds.init(this)
        Haptics.init(this)
        Snippets.init(this)
        LiveProgress.init(this)
        intro = savedInstanceState == null
        savedInstanceState?.let { b ->
            screen = b.getString(KEY_TASK)?.let { Screen.Task(it) } ?: when (b.getString(KEY_SCREEN)) {
                "new" -> Screen.NewTask
                "settings" -> Screen.Settings
                "pc-settings" -> Screen.PcSettings
                else -> Screen.Home
            }
            approval = b.getString(KEY_APPROVAL)
        }
        if (Portal.pairing.value != null) PortalService.start(this)
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        handle(intent)
        setContent {
            // Light themes need dark status-bar icons.
            val light = Void.light
            LaunchedEffect(light) {
                val style = if (light) SystemBarStyle.light(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT) else SystemBarStyle.dark(AndroidColor.TRANSPARENT)
                enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
            }
            PortalTheme { CompositionLocalProvider(LocalContentColor provides Void.text) { Root() } }
        }
    }

    // Backstop for recreations the manifest's configChanges don't cover (dark mode, font size, process death).
    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        when (val s = screen) {
            is Screen.Task -> outState.putString(KEY_TASK, s.id)
            Screen.NewTask -> outState.putString(KEY_SCREEN, "new")
            Screen.Settings -> outState.putString(KEY_SCREEN, "settings")
            Screen.PcSettings -> outState.putString(KEY_SCREEN, "pc-settings")
            Screen.Home, is Screen.Share -> Unit
        }
        approval?.let { outState.putString(KEY_APPROVAL, it) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onStart() {
        super.onStart()
        Ambience.start(this)
        Themes.refresh()
        if (Portal.link.value == Portal.Link.OFFLINE) Portal.reconnectNow()
        Portal.launch { Updater.check(this@MainActivity, quiet = true) }
    }

    override fun onStop() {
        Ambience.stop()
        super.onStop()
    }

    private fun handle(intent: Intent?) {
        intent ?: return
        intent.data?.takeIf { it.scheme.equals("voidportal", ignoreCase = true) }?.let { pairError = tryPair(it.toString()) }
        intent.getStringExtra(Notifier.EXTRA_TASK)?.let { screen = Screen.Task(it) }
        intent.getStringExtra(Notifier.EXTRA_APPROVAL)?.let { approval = it }
        shared(intent)?.let { screen = it }
    }

    /** ACTION_SEND / SEND_MULTIPLE from another app's share sheet. */
    private fun shared(intent: Intent): Screen.Share? {
        if (intent.action != Intent.ACTION_SEND && intent.action != Intent.ACTION_SEND_MULTIPLE) return null
        val text = listOfNotNull(
            intent.getStringExtra(Intent.EXTRA_SUBJECT)?.takeIf { it.isNotBlank() },
            intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.takeIf { it.isNotBlank() },
        ).distinct().joinToString("\n\n")
        val uris = if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
            IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java) ?: emptyList()
        } else {
            listOfNotNull(IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java))
        }
        val pictures = uris.filter { intent.type?.startsWith("image/") == true || contentResolver.getType(it)?.startsWith("image/") == true }
        if (text.isEmpty() && pictures.isEmpty()) return null
        // Consumed: turning the phone must not open the share screen again.
        intent.action = null
        return Screen.Share(text.take(50_000), pictures)
    }

    @Composable
    private fun Root() {
        val pairing by Portal.pairing.collectAsState()
        Box(Modifier.fillMaxSize()) {
            CosmicBackground()
            if (pairing == null) {
                PairScreen(pairError) { link -> pairError = tryPair(link) }
            } else {
                BackHandler(enabled = screen != Screen.Home) { screen = if (screen == Screen.PcSettings) Screen.Settings else Screen.Home }
                AnimatedContent(screen, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "screen") { s ->
                    when (s) {
                        Screen.Home -> HomeScreen(
                            onTask = { screen = Screen.Task(it) },
                            onNewTask = { screen = Screen.NewTask },
                            onSettings = { screen = Screen.Settings },
                            onPcSettings = { screen = Screen.PcSettings },
                            onApproval = { approval = it },
                        )
                        Screen.NewTask -> NewTaskScreen(onBack = { screen = Screen.Home }, onStarted = { screen = Screen.Task(it) })
                        Screen.Settings -> SettingsScreen(onBack = { screen = Screen.Home }, onPcSettings = { screen = Screen.PcSettings })
                        Screen.PcSettings -> PcSettingsScreen(onBack = { screen = Screen.Settings })
                        is Screen.Task -> TaskScreen(s.id, onBack = { screen = Screen.Home }, onApproval = { approval = it })
                        is Screen.Share -> ShareScreen(s.text, s.uris, onCancel = { screen = Screen.Home }, onSent = { screen = Screen.Task(it) })
                    }
                }
                approval?.let { id -> ApprovalSheet(id) { approval = null } }
            }
            if (intro) Intro { intro = false }
        }
    }

    private companion object {
        const val KEY_SCREEN = "screen"
        const val KEY_TASK = "task"
        const val KEY_APPROVAL = "approval"
    }
}

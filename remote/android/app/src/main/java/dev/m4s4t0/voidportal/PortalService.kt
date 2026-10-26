package dev.m4s4t0.voidportal

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/** Keeps the relay connection alive in the background so notifications arrive while the app is closed. */
class PortalService : LifecycleService() {
    override fun onCreate() {
        super.onCreate()
        Portal.init(this)
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0
        ServiceCompat.startForeground(this, ID, Notifier.serviceNotification(this, tr("Connecting…")), type)
        val nm = getSystemService(NotificationManager::class.java)
        // Look for app updates now and then (quietly; the app shows them on its home screen).
        lifecycleScope.launch {
            while (true) {
                delay(60_000)
                Updater.check(this@PortalService, quiet = true)
                delay(12 * 60 * 60 * 1000L)
            }
        }
        lifecycleScope.launch {
            combine(Portal.link, Portal.pc, Portal.pairing) { link, pc, p -> Triple(link, pc, p) }.collect { (link, pc, p) ->
                val name = p?.pcName ?: tr("PC")
                val text = when {
                    link != Portal.Link.CONNECTED -> tr("Reconnecting to the relay…")
                    pc == Portal.Pc.ONLINE -> tr("Connected to {name}", "name" to name)
                    pc == Portal.Pc.OFFLINE -> tr("{name} is offline", "name" to name)
                    else -> tr("Waiting for {name}", "name" to name)
                }
                nm.notify(ID, Notifier.serviceNotification(this@PortalService, text))
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        return START_STICKY
    }

    companion object {
        private const val ID = 1

        fun start(ctx: Context) {
            try {
                ContextCompat.startForegroundService(ctx, Intent(ctx, PortalService::class.java))
            } catch (e: Exception) {
                // Not allowed from the background right now; the app starts it when opened.
            }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, PortalService::class.java))
        }
    }
}

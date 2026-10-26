package dev.m4s4t0.voidportal

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import dev.m4s4t0.voidportal.ui.RUNNING_STATES
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.withContext

/** The tile's second line: what is running and what waits for you. */
fun tileSubtitle(paired: Boolean, pcOnline: Boolean, running: Int, needsYou: Int): String = when {
    !paired -> tr("Not paired")
    !pcOnline -> tr("PC offline")
    running == 0 && needsYou == 0 -> tr("Nothing running")
    else -> listOfNotNull(
        if (running > 0) tr("{n} running", "n" to running) else null,
        if (needsYou > 0) trn(needsYou, "{n} needs you", "{n} need you") else null,
    ).joinToString(" · ")
}

/** Quick Settings tile: running tasks and approvals at a glance; tap opens the app. */
class PortalTileService : TileService() {
    private var job: Job? = null

    override fun onStartListening() {
        super.onStartListening()
        Portal.init(this)
        job?.cancel()
        job = Portal.launch {
            combine(Portal.pairing, Portal.pc, Portal.tasks, Portal.approvals) { pairing, pc, tasks, approvals ->
                val running = tasks.count { it.str("state") in RUNNING_STATES }
                val needs = approvals.size + tasks.count { it.str("state") == "awaiting-plan-approval" }
                Triple(pairing != null, pc == Portal.Pc.ONLINE, running to needs)
            }.collect { (paired, online, counts) -> withContext(Dispatchers.Main) { render(paired, online, counts.first, counts.second) } }
        }
    }

    override fun onStopListening() {
        job?.cancel()
        job = null
        super.onStopListening()
    }

    private fun render(paired: Boolean, online: Boolean, running: Int, needs: Int) {
        val tile = qsTile ?: return
        tile.icon = Icon.createWithResource(this, R.drawable.ic_notification)
        tile.label = "VOID Portal"
        val sub = tileSubtitle(paired, online, running, needs)
        if (Build.VERSION.SDK_INT >= 29) tile.subtitle = sub else tile.label = "VOID · $sub"
        tile.contentDescription = "VOID Portal: $sub"
        tile.state = when {
            !paired -> Tile.STATE_UNAVAILABLE
            online && (running > 0 || needs > 0) -> Tile.STATE_ACTIVE
            else -> Tile.STATE_INACTIVE
        }
        tile.updateTile()
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    override fun onClick() {
        super.onClick()
        val i = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        // Straight to the approval when exactly one waits.
        Portal.approvals.value.singleOrNull()?.str("id")?.let { i.putExtra(Notifier.EXTRA_APPROVAL, it) }
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 5, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(i)
        }
    }
}

package dev.m4s4t0.voidportal

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput

/** Starts the connection after a reboot or an app update. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        Portal.init(context)
        if (Portal.pairing.value != null) PortalService.start(context)
    }
}

/** Allow / Deny / Allow all buttons on approval notifications, and Stop on live progress. */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val decision = intent.getStringExtra("decision") ?: return
        Portal.init(context)
        if (decision == "stop") {
            val taskId = intent.getStringExtra(Notifier.EXTRA_TASK) ?: return
            val pending = goAsync()
            Portal.launch {
                try {
                    Portal.call("task.cancel", json("taskId" to taskId), timeoutMs = 15_000)
                } catch (e: PortalError) {
                    Notifier.show(context, Cue.ALERT, tr("Could not stop the task"), e.message ?: "", null)
                } finally {
                    pending.finish()
                }
            }
            return
        }
        val id = intent.getStringExtra(Notifier.EXTRA_APPROVAL) ?: return
        val pending = goAsync()
        Portal.launch {
            try {
                val allowAll = decision == "allow" && intent.getBooleanExtra("allowAll", false)
                Portal.call("approval.respond", json("approvalId" to id, "decision" to decision, "allowAll" to if (allowAll) true else null), timeoutMs = 15_000)
                Notifier.cancelApproval(context, id)
            } catch (e: PortalError) {
                Notifier.show(context, Cue.ALERT, if (decision == "allow") tr("Could not approve") else tr("Could not deny"), e.message ?: "", null)
            } finally {
                pending.finish()
            }
        }
    }
}

/** The Reply box on task notifications: the text goes to the task (queued if the agent is busy). */
class ReplyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val taskId = intent.getStringExtra(Notifier.EXTRA_TASK) ?: return
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifier.EXTRA_REPLY)?.toString()?.trim().orEmpty()
        val nid = intent.getIntExtra("notificationId", 0)
        val progress = intent.getBooleanExtra("progress", false)
        Portal.init(context)
        val pending = goAsync()
        Portal.launch {
            try {
                if (text.isNotEmpty()) Portal.call("task.send", json("taskId" to taskId, "text" to text), timeoutMs = 15_000)
                // Re-post or remove it, or Android keeps a spinner on the reply.
                if (progress) LiveProgress.repost(context, taskId) else NotificationManagerCompat.from(context).cancel(nid)
            } catch (e: PortalError) {
                if (progress) LiveProgress.repost(context, taskId) else NotificationManagerCompat.from(context).cancel(nid)
                Notifier.show(context, Cue.ALERT, tr("Reply not sent"), e.message ?: "", taskId)
            } finally {
                pending.finish()
            }
        }
    }
}

class PortalApp : android.app.Application() {
    override fun onCreate() {
        super.onCreate()
        I18n.init(this)
        Themes.init(this)
        LiveProgress.init(this)
        Portal.init(this)
        if (Portal.pairing.value != null) PortalService.start(this)
    }
}

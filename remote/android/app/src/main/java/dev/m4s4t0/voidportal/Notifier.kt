package dev.m4s4t0.voidportal

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.compose.ui.graphics.toArgb
import dev.m4s4t0.voidportal.ui.Void

/** Kinds of notification, each with its own channel and dark VOID sound (res/raw, made by remote/sounds/make_sounds.py). */
enum class Cue(val base: String, val label: String, val raw: String, val importance: Int) {
    DONE("done", "Task finished", "void_done", NotificationManager.IMPORTANCE_HIGH),
    APPROVAL("approval", "Needs you (approvals, plans)", "void_summon", NotificationManager.IMPORTANCE_HIGH),
    ALERT("alert", "Problems and account switches", "void_alert", NotificationManager.IMPORTANCE_DEFAULT),
    PC_ONLINE("pc_online", "PC came online", "void_rise", NotificationManager.IMPORTANCE_DEFAULT),
    PC_OFFLINE("pc_offline", "PC went offline", "void_fall", NotificationManager.IMPORTANCE_HIGH),
}

object Notifier {
    const val SERVICE = "service"
    const val PROGRESS = "progress"
    const val EXTRA_REPLY = "reply"
    private const val EARLIER = "earlier"
    const val EXTRA_TASK = "taskId"
    const val EXTRA_APPROVAL = "approvalId"

    /** Bumped when the built-in sounds change, so channels made for the old ones are replaced on update. */
    private const val SOUND_GENERATION = 2

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("sounds", Context.MODE_PRIVATE)

    /** Android fixes a channel's sound when it is created, so a new sound means a new channel id. */
    fun channelId(ctx: Context, cue: Cue) = "${cue.base}_g${SOUND_GENERATION}_${prefs(ctx).getInt("v_${cue.base}", 0)}"

    // By name, not resource id: ids can shift between builds, and a channel keeps its URI forever.
    fun defaultSound(ctx: Context, cue: Cue): Uri = Uri.parse("android.resource://${ctx.packageName}/raw/${cue.raw}")

    fun sound(ctx: Context, cue: Cue): Uri = prefs(ctx).getString("sound_${cue.base}", null)?.let(Uri::parse) ?: defaultSound(ctx, cue)

    fun isCustom(ctx: Context, cue: Cue) = prefs(ctx).contains("sound_${cue.base}")

    fun ensureChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(SERVICE, "Connection", NotificationManager.IMPORTANCE_MIN).apply {
                description = "Keeps VOID Portal connected to your PC"
                setShowBadge(false)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(PROGRESS, "Live progress", NotificationManager.IMPORTANCE_LOW).apply {
                description = "What a running task is doing right now"
                setShowBadge(false)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(EARLIER, "Earlier (while offline)", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Notifications that arrived while the phone was offline, shown without sound"
            },
        )
        // Channels from older sound generations (or a replaced custom sound) go, so settings show one per kind.
        val current = Cue.entries.map { channelId(ctx, it) }.toSet() + setOf(SERVICE, EARLIER, PROGRESS)
        for (ch in nm.notificationChannels) if (ch.id !in current) nm.deleteNotificationChannel(ch.id)
        val attrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
        for (cue in Cue.entries) {
            nm.createNotificationChannel(
                NotificationChannel(channelId(ctx, cue), cue.label, cue.importance).apply {
                    setSound(sound(ctx, cue), attrs)
                    enableVibration(true)
                },
            )
        }
    }

    /** Use another sound (null = back to the VOID sound) for one kind of notification. */
    fun setSound(ctx: Context, cue: Cue, uri: Uri?) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.deleteNotificationChannel(channelId(ctx, cue))
        val p = prefs(ctx).edit().putInt("v_${cue.base}", prefs(ctx).getInt("v_${cue.base}", 0) + 1)
        if (uri == null) p.remove("sound_${cue.base}") else p.putString("sound_${cue.base}", uri.toString())
        p.apply()
        ensureChannels(ctx)
    }

    fun preview(ctx: Context, cue: Cue) {
        RingtoneManager.getRingtone(ctx, sound(ctx, cue))?.play()
    }

    fun openApp(ctx: Context, taskId: String?, approvalId: String?, requestCode: Int): PendingIntent {
        val i = Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        taskId?.let { i.putExtra(EXTRA_TASK, it) }
        approvalId?.let { i.putExtra(EXTRA_APPROVAL, it) }
        return PendingIntent.getActivity(ctx, requestCode, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    @SuppressLint("MissingPermission")
    fun show(ctx: Context, cue: Cue, title: String, body: String, taskId: String?, silent: Boolean = false, approvalId: String? = null) {
        val id = when {
            approvalId != null -> approvalId.hashCode()
            cue == Cue.PC_ONLINE || cue == Cue.PC_OFFLINE -> 2
            taskId != null -> taskId.hashCode()
            else -> (System.currentTimeMillis() % Int.MAX_VALUE).toInt()
        }
        val b = NotificationCompat.Builder(ctx, if (silent) EARLIER else channelId(ctx, cue))
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(Void.violet.toArgb())
            .setContentTitle(title)
            .setContentText(body.lineSequence().firstOrNull() ?: "")
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setContentIntent(openApp(ctx, taskId, approvalId, id))
            .setCategory(if (cue == Cue.APPROVAL) Notification.CATEGORY_REMINDER else Notification.CATEGORY_STATUS)
        // Answer the agent right from the notification (a plan to approve has its own buttons in the app).
        if (taskId != null && approvalId == null && cue != Cue.PC_ONLINE && cue != Cue.PC_OFFLINE) b.addAction(replyAction(ctx, taskId, id, progress = false, label = "Reply"))
        try {
            NotificationManagerCompat.from(ctx).notify(id, b.build())
        } catch (e: SecurityException) {
            // Notifications not allowed; the app still shows everything on screen.
        }
    }

    /** "Approval needed", with Allow / Deny right on the notification. */
    @SuppressLint("MissingPermission")
    fun showApproval(ctx: Context, approval: kotlinx.serialization.json.JsonObject) {
        val id = approval.str("id") ?: return
        val detail = approval.str("command") ?: approval.str("rel") ?: ""
        val action = { decision: String, code: Int ->
            PendingIntent.getBroadcast(
                ctx,
                id.hashCode() + code,
                Intent(ctx, ActionReceiver::class.java).putExtra(EXTRA_APPROVAL, id).putExtra("decision", decision).putExtra("allowAll", code == 3),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
        val allowLabel = when (approval.str("kind")) {
            "command" -> "Run once"
            "file-change" -> "Apply"
            else -> "Allow"
        }
        val b = NotificationCompat.Builder(ctx, channelId(ctx, Cue.APPROVAL))
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(Void.violet.toArgb())
            .setContentTitle(if (approval.bool("publishes") == true) "Approval needed · publishes" else "Approval needed")
            .setContentText(approval.str("summary") ?: "")
            .setStyle(NotificationCompat.BigTextStyle().bigText("${approval.str("summary") ?: ""}\n$detail".trim()))
            .setContentIntent(openApp(ctx, approval.str("taskId"), id, id.hashCode()))
            .addAction(0, "Deny", action("deny", 1))
            .addAction(0, allowLabel, action("allow", 2))
            .apply { if (approval.bool("canAllowAll") == true) addAction(0, "Allow all", action("allow", 3)) }
            .setAutoCancel(true)
            .setCategory(Notification.CATEGORY_REMINDER)
        try {
            NotificationManagerCompat.from(ctx).notify(id.hashCode(), b.build())
        } catch (e: SecurityException) {
            // Notifications not allowed.
        }
    }

    /** A "Reply" button with a text box; ReplyReceiver sends the text to the task. */
    fun replyAction(ctx: Context, taskId: String, notificationId: Int, progress: Boolean, label: String): NotificationCompat.Action {
        val intent = Intent(ctx, ReplyReceiver::class.java)
            .putExtra(EXTRA_TASK, taskId)
            .putExtra("notificationId", notificationId)
            .putExtra("progress", progress)
        // The text box fills the intent in, so it has to be mutable; it is explicit, so nothing else can receive it.
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
        val pi = PendingIntent.getBroadcast(ctx, notificationId + 7, intent, flags)
        val input = RemoteInput.Builder(EXTRA_REPLY).setLabel("Message to the agent").build()
        return NotificationCompat.Action.Builder(0, label, pi).addRemoteInput(input).setAllowGeneratedReplies(false).build()
    }

    fun cancelApproval(ctx: Context, approvalId: String?) {
        approvalId?.let { NotificationManagerCompat.from(ctx).cancel(it.hashCode()) }
    }

    fun serviceNotification(ctx: Context, text: String): Notification =
        NotificationCompat.Builder(ctx, SERVICE)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(Void.violet.toArgb())
            .setContentTitle("VOID Portal")
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(openApp(ctx, null, null, 1))
            .build()
}

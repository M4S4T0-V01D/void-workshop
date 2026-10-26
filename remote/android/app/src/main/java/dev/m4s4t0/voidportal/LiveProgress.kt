package dev.m4s4t0.voidportal

import android.annotation.SuppressLint
import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.compose.ui.graphics.toArgb
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import dev.m4s4t0.voidportal.ui.RUNNING_STATES
import dev.m4s4t0.voidportal.ui.Void
import dev.m4s4t0.voidportal.ui.projectName
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.JsonObject

/** How far a task's to-do list is: finished steps, all steps, and the step being worked on. */
data class TodoProgress(val done: Int, val total: Int, val current: String?)

/** Read an agent.todos list ({subject, description, status}); the current step is the one in progress. */
fun todoProgress(items: List<JsonObject>): TodoProgress {
    val now = items.firstOrNull { it.str("status") == "in_progress" }
    return TodoProgress(
        done = items.count { it.str("status") == "completed" },
        total = items.size,
        current = now?.let { it.str("description")?.takeIf(String::isNotBlank) ?: it.str("subject") },
    )
}

/**
 * One silent, ongoing notification per running task: what it is doing, how far its to-do list is, how long it has run,
 * with Stop and Reply. On Android 16 it asks to be promoted to a Live Update (status bar chip, lock screen).
 */
object LiveProgress {
    private data class Run(
        val taskId: String,
        val title: String,
        val project: String,
        val startedAt: Long,
        val tool: String? = null,
        val todos: TodoProgress? = null,
    )

    val enabled = MutableStateFlow(true)
    private val runs = ConcurrentHashMap<String, Run>()
    private val lastPost = ConcurrentHashMap<String, Long>()
    private val scheduled = ConcurrentHashMap.newKeySet<String>()
    private const val MIN_GAP_MS = 1500L

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("ui", Context.MODE_PRIVATE)

    fun init(ctx: Context) {
        enabled.value = prefs(ctx).getBoolean("liveProgress", true)
    }

    fun setEnabled(ctx: Context, on: Boolean) {
        enabled.value = on
        prefs(ctx).edit().putBoolean("liveProgress", on).apply()
        if (on) for (id in runs.keys) post(ctx, id, force = true) else for (id in runs.keys) cancel(ctx, id)
    }

    fun notificationId(taskId: String) = "progress:$taskId".hashCode()

    /** task.updated, or a task from remote.state. */
    fun onTask(ctx: Context, t: JsonObject) {
        val id = t.str("id") ?: return
        if (t.str("state") in RUNNING_STATES) {
            val title = t.str("title") ?: tr("Task")
            val project = projectName(t.str("project"))
            val run = runs[id]?.copy(title = title, project = project) ?: Run(id, title, project, System.currentTimeMillis())
            runs[id] = run
            post(ctx, id)
        } else if (runs.remove(id) != null) {
            cancel(ctx, id)
        }
    }

    /** The full task list (remote.state): drop notifications for tasks that stopped while we weren't listening. */
    fun sync(ctx: Context, tasks: List<JsonObject>) {
        val running = tasks.filter { it.str("state") in RUNNING_STATES }.mapNotNull { it.str("id") }.toSet()
        for (id in runs.keys - running) {
            runs.remove(id)
            cancel(ctx, id)
        }
        for (t in tasks) if (t.str("id") in running) onTask(ctx, t)
    }

    fun onTool(ctx: Context, taskId: String, summary: String?) {
        val run = runs[taskId] ?: return
        runs[taskId] = run.copy(tool = summary?.lineSequence()?.firstOrNull()?.take(120))
        post(ctx, taskId)
    }

    fun onTodos(ctx: Context, taskId: String, items: List<JsonObject>) {
        val run = runs[taskId] ?: return
        runs[taskId] = run.copy(todos = todoProgress(items).takeIf { it.total > 0 })
        post(ctx, taskId)
    }

    /** The PC went away or the phone was unpaired: nothing shown is live any more. */
    fun clear(ctx: Context) {
        for (id in runs.keys) cancel(ctx, id)
        runs.clear()
    }

    /** Show it again as it is (after a reply, Android leaves a spinner on the notification until it is re-posted). */
    fun repost(ctx: Context, taskId: String) = post(ctx, taskId, force = true)

    private fun cancel(ctx: Context, taskId: String) {
        lastPost.remove(taskId)
        NotificationManagerCompat.from(ctx).cancel(notificationId(taskId))
    }

    /** Android drops updates that come too fast, so tool calls in a burst become one update. */
    private fun post(ctx: Context, taskId: String, force: Boolean = false) {
        if (!enabled.value) return
        val wait = (lastPost[taskId] ?: 0L) + MIN_GAP_MS - System.currentTimeMillis()
        if (force || wait <= 0) {
            show(ctx, taskId)
            return
        }
        if (!scheduled.add(taskId)) return
        Portal.launch {
            delay(wait)
            scheduled.remove(taskId)
            show(ctx, taskId)
        }
    }

    @SuppressLint("MissingPermission")
    private fun show(ctx: Context, taskId: String) {
        val run = runs[taskId] ?: return
        if (!enabled.value) return
        lastPost[taskId] = System.currentTimeMillis()
        val todos = run.todos
        val step = todos?.current ?: run.tool ?: tr("Working…")
        val detail = listOfNotNull(todos?.current, run.tool).distinct().joinToString("\n")
        val nid = notificationId(taskId)
        val stop = PendingIntent.getBroadcast(
            ctx,
            nid + 1,
            Intent(ctx, ActionReceiver::class.java).putExtra(Notifier.EXTRA_TASK, taskId).putExtra("decision", "stop"),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val b = NotificationCompat.Builder(ctx, Notifier.PROGRESS)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(Void.violet.toArgb())
            .setContentTitle(run.title)
            .setContentText(step)
            .setSubText(run.project.takeIf { it.isNotEmpty() })
            .setStyle(NotificationCompat.BigTextStyle().bigText(detail.ifEmpty { step }))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(true)
            .setWhen(run.startedAt)
            .setUsesChronometer(true)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setContentIntent(Notifier.openApp(ctx, taskId, null, nid))
            .addAction(0, tr("Stop"), stop)
            .addAction(Notifier.replyAction(ctx, taskId, nid, progress = true, label = tr("Reply")))
            .apply {
                if (todos != null) setProgress(todos.total, todos.done, false) else setProgress(0, 0, true)
                // Android 16 Live Updates (NotificationCompat has no setter for these yet).
                addExtras(
                    Bundle().apply {
                        putBoolean("android.requestPromotedOngoing", true)
                        putString("android.shortCriticalText", todos?.let { "${it.done}/${it.total}" } ?: tr("Working"))
                    },
                )
            }
        try {
            NotificationManagerCompat.from(ctx).notify(nid, b.build())
        } catch (e: SecurityException) {
            // Notifications not allowed.
        }
    }
}

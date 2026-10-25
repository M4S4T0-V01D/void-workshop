package dev.m4s4t0.voidportal

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.SoundPool
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * Short interface sounds (send, queue, new task), preloaded in a SoundPool so they play the instant
 * you tap. Quiet when the phone is on silent or vibrate, and switchable in Settings.
 */
object UiSounds {
    enum class Kind(val raw: Int, val volume: Float) {
        SEND(R.raw.send_zap, 0.55f),
        QUEUE(R.raw.queue_plink, 0.55f),
        NEW_TASK(R.raw.task_launch, 0.6f),
    }

    val enabled = MutableStateFlow(true)
    private var pool: SoundPool? = null
    private val ids = HashMap<Kind, Int>()
    private lateinit var app: Context

    fun init(ctx: Context) {
        if (pool != null) return
        app = ctx.applicationContext
        enabled.value = app.getSharedPreferences("ui", Context.MODE_PRIVATE).getBoolean("uiSounds", true)
        val p = SoundPool.Builder()
            .setMaxStreams(3)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
            .build()
        for (k in Kind.entries) ids[k] = p.load(app, k.raw, 1)
        pool = p
    }

    fun setEnabled(ctx: Context, on: Boolean) {
        enabled.value = on
        ctx.getSharedPreferences("ui", Context.MODE_PRIVATE).edit().putBoolean("uiSounds", on).apply()
    }

    fun play(kind: Kind) {
        if (!enabled.value || !::app.isInitialized) return
        val am = app.getSystemService(AudioManager::class.java)
        if (am != null && am.ringerMode != AudioManager.RINGER_MODE_NORMAL) return
        val id = ids[kind] ?: return
        pool?.play(id, kind.volume, kind.volume, 1, 0, 1f)
    }
}

package dev.m4s4t0.voidportal

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * The low cosmic drone that plays while VOID Portal is on screen. It fades in and out, stays quiet,
 * never starts over music the phone is already playing, and can be muted in the app.
 */
object Ambience {
    private const val VOLUME = 0.22f
    private const val FADE_MS = 1800L
    private const val STEPS = 30

    val enabled = MutableStateFlow(true)
    private var player: MediaPlayer? = null
    private val main = Handler(Looper.getMainLooper())
    private var level = 0f
    private var fading: Runnable? = null

    fun init(ctx: Context) {
        enabled.value = ctx.getSharedPreferences("ui", Context.MODE_PRIVATE).getBoolean("ambience", true)
    }

    fun setEnabled(ctx: Context, on: Boolean) {
        enabled.value = on
        ctx.getSharedPreferences("ui", Context.MODE_PRIVATE).edit().putBoolean("ambience", on).apply()
        if (on) start(ctx) else stop()
    }

    /** Call when the app comes to the foreground. */
    fun start(ctx: Context) {
        if (!enabled.value) return
        val am = ctx.getSystemService(AudioManager::class.java)
        if (am?.isMusicActive == true && player == null) return // the user is listening to something else
        val p = player ?: try {
            MediaPlayer.create(
                ctx,
                R.raw.ambient_drone,
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_GAME).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build(),
                am?.generateAudioSessionId() ?: 0,
            )?.apply { isLooping = true }
        } catch (e: Exception) {
            null
        } ?: return
        player = p
        if (!p.isPlaying) {
            p.setVolume(level, level)
            p.start()
        }
        fadeTo(VOLUME, null)
    }

    /** Call when the app leaves the foreground. */
    fun stop() {
        val p = player ?: return
        fadeTo(0f) {
            p.release()
            if (player === p) player = null
        }
    }

    private fun fadeTo(target: Float, done: (() -> Unit)?) {
        fading?.let(main::removeCallbacks)
        val from = level
        var step = 0
        val r = object : Runnable {
            override fun run() {
                step++
                level = from + (target - from) * step / STEPS
                try {
                    player?.setVolume(level, level)
                } catch (e: IllegalStateException) {
                    return
                }
                if (step < STEPS) main.postDelayed(this, FADE_MS / STEPS) else done?.invoke()
            }
        }
        fading = r
        main.post(r)
    }
}

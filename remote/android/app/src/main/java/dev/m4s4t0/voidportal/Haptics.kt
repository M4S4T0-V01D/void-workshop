package dev.m4s4t0.voidportal

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import kotlinx.coroutines.flow.MutableStateFlow

/** Short taps for things that happened on the PC: approved, denied, sent, committed. */
object Haptics {
    val enabled = MutableStateFlow(true)

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("ui", Context.MODE_PRIVATE)

    fun init(ctx: Context) {
        enabled.value = prefs(ctx).getBoolean("haptics", true)
    }

    fun setEnabled(ctx: Context, on: Boolean) {
        enabled.value = on
        prefs(ctx).edit().putBoolean("haptics", on).apply()
        if (on) tick(ctx)
    }

    /** A light tap (a chip, a toggle). */
    fun tick(ctx: Context) = play(ctx, if (Build.VERSION.SDK_INT >= 29) VibrationEffect.EFFECT_TICK else -1, 10)

    /** It went through (approve, send, commit). */
    fun confirm(ctx: Context) = play(ctx, if (Build.VERSION.SDK_INT >= 29) VibrationEffect.EFFECT_CLICK else -1, 25)

    /** Denied, or it failed. */
    fun reject(ctx: Context) = play(ctx, if (Build.VERSION.SDK_INT >= 29) VibrationEffect.EFFECT_DOUBLE_CLICK else -1, 60)

    private fun play(ctx: Context, predefined: Int, fallbackMs: Long) {
        if (!enabled.value) return
        val v = if (Build.VERSION.SDK_INT >= 31) ctx.getSystemService(VibratorManager::class.java)?.defaultVibrator
        else @Suppress("DEPRECATION") ctx.getSystemService(Vibrator::class.java)
        if (v == null || !v.hasVibrator()) return
        try {
            v.vibrate(if (Build.VERSION.SDK_INT >= 29 && predefined >= 0) VibrationEffect.createPredefined(predefined) else VibrationEffect.createOneShot(fallbackMs, VibrationEffect.DEFAULT_AMPLITUDE))
        } catch (e: Exception) {
            // Some devices refuse; a missing tap is fine.
        }
    }
}

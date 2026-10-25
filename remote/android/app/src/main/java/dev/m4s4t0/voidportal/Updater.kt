package dev.m4s4t0.voidportal

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * In-app updates. Releases live in the relay's private R2 bucket (remote/android/release.sh puts them
 * there); only a paired phone can fetch them, with the same token it uses for its relay channel.
 * The APK is checked against the published SHA-256, then handed to Android's installer, which asks
 * the user to confirm (Android always does that for apps outside an app store).
 */
object Updater {
    data class Release(val versionCode: Int, val versionName: String, val sha256: String, val size: Long, val notes: String)

    sealed interface State {
        data object Idle : State
        data object Checking : State
        data object UpToDate : State
        data class Available(val release: Release) : State
        data class Downloading(val release: Release, val progress: Float) : State
        data class Installing(val release: Release) : State
        data class Failed(val message: String, val release: Release? = null) : State
    }

    val state = MutableStateFlow<State>(State.Idle)
    private val client = OkHttpClient.Builder().callTimeout(10, TimeUnit.MINUTES).build()
    private const val CHECK_EVERY_MS = 3 * 60 * 60 * 1000L

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("updates", Context.MODE_PRIVATE)

    private fun request(path: String): Request? {
        val p = Portal.pairing.value ?: return null
        return Request.Builder()
            .url(p.relayUrl.replaceFirst("wss://", "https://") + path)
            .header("Authorization", "Bearer ${p.keys.token}")
            .header("X-Void-Channel", p.keys.channelId)
            .build()
    }

    /** Ask the relay for the latest release. [quiet] skips it if checked recently and keeps errors silent. */
    suspend fun check(ctx: Context, quiet: Boolean = false): Release? = withContext(Dispatchers.IO) {
        if (state.value is State.Downloading || state.value is State.Installing) return@withContext null
        val now = System.currentTimeMillis()
        if (quiet && now - prefs(ctx).getLong("lastCheck", 0) < CHECK_EVERY_MS) return@withContext (state.value as? State.Available)?.release
        val req = request("/v1/update/latest.json") ?: return@withContext null
        if (!quiet) state.value = State.Checking
        try {
            client.newCall(req).execute().use { res ->
                if (res.code == 404) {
                    state.value = State.UpToDate
                    return@withContext null
                }
                if (!res.isSuccessful) throw IllegalStateException("The relay answered ${res.code}")
                val j = Json.parseToJsonElement(res.body!!.string()).jsonObject
                val r = Release(
                    versionCode = j.num("versionCode")?.toInt() ?: 0,
                    versionName = j.str("versionName") ?: "?",
                    sha256 = j.str("sha256") ?: "",
                    size = j.num("size")?.toLong() ?: 0,
                    notes = j.str("notes") ?: "",
                )
                prefs(ctx).edit().putLong("lastCheck", now).apply()
                if (r.versionCode > BuildConfig.VERSION_CODE) {
                    state.value = State.Available(r)
                    if (prefs(ctx).getInt("notified", 0) < r.versionCode) {
                        prefs(ctx).edit().putInt("notified", r.versionCode).apply()
                        Notifier.show(ctx, Cue.ALERT, "VOID Portal ${r.versionName} is ready", r.notes.ifBlank { "Tap to update." }, null)
                    }
                    r
                } else {
                    state.value = State.UpToDate
                    null
                }
            }
        } catch (e: Exception) {
            if (!quiet) state.value = State.Failed("Could not check for updates: ${e.message}")
            null
        }
    }

    /** Download, verify and install [r]. May first send the user to allow installs from this app. */
    suspend fun install(ctx: Context, r: Release) {
        val pm = ctx.packageManager
        if (!pm.canRequestPackageInstalls()) {
            state.value = State.Failed("Allow VOID Portal to install updates, then tap Update again.", r)
            ctx.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            return
        }
        try {
            val file = withContext(Dispatchers.IO) { download(ctx, r) }
            state.value = State.Installing(r)
            withContext(Dispatchers.IO) { commit(ctx, file) }
        } catch (e: Exception) {
            state.value = State.Failed(e.message ?: "The update failed.", r)
        }
    }

    private fun download(ctx: Context, r: Release): File {
        val req = request("/v1/update/apk/${r.versionCode}.apk") ?: throw IllegalStateException("Not paired")
        val out = File(ctx.cacheDir, "update-${r.versionCode}.apk")
        val digest = MessageDigest.getInstance("SHA-256")
        client.newCall(req).execute().use { res ->
            if (!res.isSuccessful) throw IllegalStateException("Download failed (${res.code})")
            val body = res.body ?: throw IllegalStateException("Empty download")
            val total = body.contentLength().takeIf { it > 0 } ?: r.size
            var done = 0L
            var lastShown = 0f
            body.byteStream().use { input ->
                out.outputStream().use { o ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        o.write(buf, 0, n)
                        digest.update(buf, 0, n)
                        done += n
                        val p = if (total > 0) done.toFloat() / total else 0f
                        if (p - lastShown > 0.02f) {
                            lastShown = p
                            state.value = State.Downloading(r, p)
                        }
                    }
                }
            }
        }
        val sha = digest.digest().joinToString("") { "%02x".format(it) }
        if (!sha.equals(r.sha256, ignoreCase = true)) {
            out.delete()
            throw IllegalStateException("The download was damaged (checksum mismatch). Try again.")
        }
        return out
    }

    private fun commit(ctx: Context, apk: File) {
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(ctx.packageName)
            if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            session.openWrite("void-portal.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val intent = Intent(ctx, UpdateReceiver::class.java)
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
            session.commit(PendingIntent.getBroadcast(ctx, id, intent, flags).intentSender)
        }
        apk.delete()
    }
}

/** The installer's answer: ask the user to confirm, or report a failure. Success restarts the app. */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirm = androidx.core.content.IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java) ?: return
                context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            PackageInstaller.STATUS_SUCCESS -> Unit
            else -> {
                val msg = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "Installation failed"
                val r = (Updater.state.value as? Updater.State.Installing)?.release
                Updater.state.value = Updater.State.Failed("The update was not installed: $msg", r)
            }
        }
    }
}

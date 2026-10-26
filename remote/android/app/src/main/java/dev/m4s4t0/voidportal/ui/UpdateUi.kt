package dev.m4s4t0.voidportal.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SystemUpdate
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.m4s4t0.voidportal.BuildConfig
import dev.m4s4t0.voidportal.Portal
import dev.m4s4t0.voidportal.Updater
import dev.m4s4t0.voidportal.tr

/** Home-screen banner while an update is available, downloading or waiting for the installer. */
@Composable
fun UpdateBanner() {
    val st by Updater.state.collectAsState()
    val release = when (val s = st) {
        is Updater.State.Available -> s.release
        is Updater.State.Downloading -> s.release
        is Updater.State.Installing -> s.release
        is Updater.State.Failed -> s.release
        else -> null
    } ?: return
    Card {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Icons.Default.SystemUpdate, null, tint = Void.cyan)
            Text(tr("VOID Portal {version} is ready", "version" to release.versionName), fontWeight = FontWeight.SemiBold)
        }
        if (release.notes.isNotBlank()) Text(release.notes, color = Void.dim, fontSize = 13.sp)
        UpdateAction(st, release)
    }
}

@Composable
private fun UpdateAction(st: Updater.State, release: Updater.Release) {
    val ctx = LocalContext.current
    when (st) {
        is Updater.State.Downloading -> {
            LinearProgressIndicator(progress = { st.progress }, modifier = Modifier.fillMaxWidth(), color = Void.violet)
            Text(tr("Downloading… {percent}%", "percent" to (st.progress * 100).toInt()), color = Void.dim, fontSize = 12.sp)
        }
        is Updater.State.Installing -> Text(tr("Confirm the update in Android's installer."), color = Void.dim, fontSize = 13.sp)
        else -> {
            if (st is Updater.State.Failed) Text(st.message, color = Void.warn, fontSize = 13.sp)
            Button(onClick = { Portal.launch { Updater.install(ctx, release) } }) { Text(tr("Update")) }
        }
    }
}

/** Settings card: current version, check button, and the update flow. */
@Composable
fun UpdatesCard() {
    val ctx = LocalContext.current
    val st by Updater.state.collectAsState()
    Card {
        Text("VOID Portal ${BuildConfig.VERSION_NAME}", fontWeight = FontWeight.Medium)
        Text(
            when (st) {
                Updater.State.Checking -> tr("Checking…")
                Updater.State.UpToDate -> tr("You have the latest version.")
                is Updater.State.Available, is Updater.State.Downloading, is Updater.State.Installing -> tr("An update is ready.")
                is Updater.State.Failed -> (st as Updater.State.Failed).message
                Updater.State.Idle -> tr("Updates come from your relay; only this paired phone can download them.")
            },
            color = Void.dim,
            fontSize = 13.sp,
        )
        when (val s = st) {
            is Updater.State.Available -> UpdateAction(s, s.release)
            is Updater.State.Downloading -> UpdateAction(s, s.release)
            is Updater.State.Installing -> UpdateAction(s, s.release)
            is Updater.State.Failed -> s.release?.let { UpdateAction(s, it) } ?: OutlinedButton(onClick = { Portal.launch { Updater.check(ctx) } }) { Text(tr("Check for updates")) }
            else -> OutlinedButton(onClick = { Portal.launch { Updater.check(ctx) } }, enabled = st != Updater.State.Checking) { Text(tr("Check for updates")) }
        }
    }
}

package dev.m4s4t0.voidportal.ui

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AdminPanelSettings
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.m4s4t0.voidportal.Portal
import dev.m4s4t0.voidportal.PortalError
import dev.m4s4t0.voidportal.bool
import dev.m4s4t0.voidportal.json
import dev.m4s4t0.voidportal.num
import dev.m4s4t0.voidportal.obj
import dev.m4s4t0.voidportal.str
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/** Admin passwords need at least this many characters (the PC checks too). */
private const val MIN_PASSWORD = 6

/** "since 12 min · from the PC" for a running admin session. */
private fun adminLine(admin: JsonObject): String {
    val since = ago(admin.num("since")).let { if (it == "now") "just now" else "since $it" }
    val from = if (admin.str("by") == "phone") admin.str("device") ?: "a phone" else "the PC"
    return "$since · from $from"
}

/** The home screen's warning strip while an admin dev session runs; ends it after a confirmation. */
@Composable
fun AdminBanner(onError: (String) -> Unit) {
    val state by Portal.state.collectAsState()
    val restart by Portal.adminRestart.collectAsState()
    val admin = state?.obj("admin")?.takeIf { it.bool("active") == true } ?: return
    var confirm by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val pulse by rememberInfiniteTransition(label = "admin").animateFloat(0.35f, 0.95f, infiniteRepeatable(tween(1_800), RepeatMode.Reverse), label = "pulse")
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(Void.warn.copy(alpha = 0.12f))
            .border(1.dp, Void.warn.copy(alpha = pulse), RoundedCornerShape(16.dp))
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Icon(Icons.Default.AdminPanelSettings, null, tint = Void.warn)
            Column(Modifier.weight(1f)) {
                Text("ADMIN DEV SESSION", color = Void.warn, fontSize = 12.sp, letterSpacing = 2.sp, fontWeight = FontWeight.Bold)
                Text(adminLine(admin), color = Void.dim, fontSize = 12.sp)
            }
            OutlinedButton(onClick = { confirm = true }, enabled = !busy) { Text("End", color = Void.warn) }
        }
        Text("The agent may change VOID Workshop and VOID Portal themselves.", fontSize = 13.sp)
        restart?.let { r ->
            val text = when {
                r.str("phase") == "restarting" -> if (r.bool("install") == true) "Restarting Workshop with the new build…" else "Restarting Workshop…"
                else -> "Restart queued: it happens when the task's turn ends${r.str("reason")?.let { " · $it" } ?: ""}"
            }
            Text(text, color = Void.cyan, fontSize = 13.sp)
            if (r.str("phase") == "restarting") LinearProgressIndicator(Modifier.fillMaxWidth(), color = Void.cyan, trackColor = Color.Transparent)
        }
    }
    if (confirm) {
        EndAdminDialog(
            onDismiss = { confirm = false },
            onEnd = {
                confirm = false
                busy = true
                scope.launch {
                    try {
                        endAdmin()
                    } catch (e: PortalError) {
                        onError(e.message ?: "Could not end the admin session")
                    } finally {
                        busy = false
                    }
                }
            },
        )
    }
}

@Composable
private fun EndAdminDialog(onDismiss: () -> Unit, onEnd: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("End the admin session?") },
        text = { Text("Tasks still working in the admin session are stopped. Workshop goes back to normal.") },
        confirmButton = { TextButton(onClick = onEnd) { Text("End session", color = Void.warn) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        containerColor = Void.panel,
    )
}

private suspend fun endAdmin() {
    val status = Portal.call("admin.end") as? JsonObject
    status?.let { Portal.state.value = Portal.state.value?.let { s -> JsonObject(s + ("admin" to it)) } }
    Portal.adminRestart.value = null
}

/** A masked password field with a show/hide eye. */
@Composable
fun PasswordField(value: String, onChange: (String) -> Unit, label: String, onDone: (() -> Unit)? = null) {
    var shown by remember { mutableStateOf(false) }
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
        visualTransformation = if (shown) VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = if (onDone != null) ImeAction.Done else ImeAction.Next),
        keyboardActions = KeyboardActions(onDone = { onDone?.invoke() }),
        trailingIcon = {
            IconButton(onClick = { shown = !shown }) {
                Icon(if (shown) Icons.Default.VisibilityOff else Icons.Default.Visibility, if (shown) "Hide" else "Show")
            }
        },
    )
}

/** Why the PC refused a password, in words for the dialog. */
fun adminErrorText(e: PortalError): String = when (e.code) {
    "admin-password" -> "Wrong admin password."
    else -> e.message ?: "The PC refused it."
}

/**
 * Asks for the admin password and runs [action] with it; the dialog stays open with the PC's answer when it fails
 * (wrong password, locked after five tries).
 */
@Composable
fun AdminPasswordDialog(title: String, text: String, confirm: String, onDismiss: () -> Unit, action: suspend (String) -> Unit) {
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    fun submit() {
        if (password.isEmpty() || busy) return
        busy = true
        error = null
        scope.launch {
            try {
                action(password)
                onDismiss()
            } catch (e: PortalError) {
                error = adminErrorText(e)
            } finally {
                busy = false
            }
        }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(text, color = Void.dim, fontSize = 14.sp)
                PasswordField(password, { password = it; error = null }, "Admin password", onDone = ::submit)
                error?.let { Text(it, color = Void.bad, fontSize = 13.sp) }
            }
        },
        confirmButton = { TextButton(onClick = ::submit, enabled = password.isNotEmpty() && !busy) { Text(if (busy) "Checking…" else confirm) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        containerColor = Void.panel,
    )
}

@Composable
private fun ChangePasswordDialog(onDismiss: () -> Unit, onChanged: () -> Unit) {
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var repeat by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val problem = when {
        next.isNotEmpty() && next.length < MIN_PASSWORD -> "Use at least $MIN_PASSWORD characters."
        repeat.isNotEmpty() && repeat != next -> "The new passwords don't match."
        else -> null
    }
    val ready = current.isNotEmpty() && next.length >= MIN_PASSWORD && next == repeat && !busy
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Change admin password") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                PasswordField(current, { current = it; error = null }, "Current password")
                PasswordField(next, { next = it; error = null }, "New password")
                PasswordField(repeat, { repeat = it; error = null }, "Repeat the new password")
                (error ?: problem)?.let { Text(it, color = Void.bad, fontSize = 13.sp) }
            }
        },
        confirmButton = {
            TextButton(
                enabled = ready,
                onClick = {
                    busy = true
                    scope.launch {
                        try {
                            Portal.call("admin.setPassword", json("password" to next, "current" to current))
                            onChanged()
                            onDismiss()
                        } catch (e: PortalError) {
                            error = if (e.code == "admin-password") "The current password is wrong." else adminErrorText(e)
                        } finally {
                            busy = false
                        }
                    }
                },
            ) { Text(if (busy) "Saving…" else "Change") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
        containerColor = Void.panel,
    )
}

/** Shown when the PC runs a VOID Workshop from before admin sessions and PC settings. */
const val UPDATE_PC = "Update VOID Workshop on the PC to use this (run ./scripts/install.sh there and restart it)."

/** Settings → Admin: start or end the admin dev session, change its password. */
@Composable
fun AdminCard(onMessage: (String) -> Unit) {
    val state by Portal.state.collectAsState()
    val admin = state?.obj("admin")
    var starting by remember { mutableStateOf(false) }
    var ending by remember { mutableStateOf(false) }
    var changing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Card {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Icons.Default.AdminPanelSettings, null, tint = if (admin?.bool("active") == true) Void.warn else Void.dim)
            Text("Admin dev session", fontWeight = FontWeight.Medium)
        }
        Text(
            "Lets the agent change VOID Workshop and VOID Portal themselves: their source, Workshop's logs, installing a new build and restarting into it. " +
                "Ending the session puts everything back to normal.",
            color = Void.dim,
            fontSize = 13.sp,
        )
        when {
            state == null -> Text("Connect to the PC to see the admin session.", color = Void.dim, fontSize = 13.sp)
            // An older VOID Workshop on the PC has no admin sessions (its state has no "admin").
            admin == null -> Text(UPDATE_PC, color = Void.warn, fontSize = 13.sp)
            admin.bool("passwordSet") != true -> Text("Set an admin password on the PC first (Settings → Admin).", color = Void.warn, fontSize = 13.sp)
            admin.bool("active") == true -> {
                StatusLine(Void.warn, "Running · ${adminLine(admin)}")
                Button(onClick = { ending = true }, colors = ButtonDefaults.buttonColors(containerColor = Void.warn.copy(alpha = 0.85f))) { Text("End admin session") }
            }
            else -> {
                admin.num("lockedUntil")?.takeIf { it > System.currentTimeMillis() }?.let {
                    Text("Locked after too many wrong passwords; try again later.", color = Void.bad, fontSize = 13.sp)
                }
                Button(onClick = { starting = true }) { Text("Start admin session") }
            }
        }
        if (admin?.bool("passwordSet") == true) TextButton(onClick = { changing = true }) { Text("Change admin password") }
    }
    if (starting) {
        AdminPasswordDialog(
            title = "Start admin session",
            text = "The agent may then change VOID Workshop and VOID Portal until you end the session here or on the PC.",
            confirm = "Start",
            onDismiss = { starting = false },
        ) { pw ->
            val status = Portal.call("admin.start", json("password" to pw)) as? JsonObject
            status?.let { Portal.state.value = Portal.state.value?.let { s -> JsonObject(s + ("admin" to it)) } }
        }
    }
    if (ending) {
        EndAdminDialog(onDismiss = { ending = false }) {
            ending = false
            scope.launch {
                try {
                    endAdmin()
                } catch (e: PortalError) {
                    onMessage(e.message ?: "Could not end the admin session")
                }
            }
        }
    }
    if (changing) ChangePasswordDialog(onDismiss = { changing = false }) { onMessage("Admin password changed") }
}

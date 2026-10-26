package dev.m4s4t0.voidportal.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.m4s4t0.voidportal.Haptics
import dev.m4s4t0.voidportal.Snippets
import dev.m4s4t0.voidportal.tr

/**
 * Saved prompts as chips: tap puts one in the message, long-press offers to delete it, "+" saves a new one
 * ([current] prefills it, so a message typed once can be kept).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun SnippetChips(current: String = "", onPick: (String) -> Unit) {
    val ctx = LocalContext.current
    val items by Snippets.items.collectAsState()
    var adding by remember { mutableStateOf<String?>(null) }
    var deleting by remember { mutableStateOf<String?>(null) }
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Chip(tr("+ Save"), Void.violet, onClick = { adding = current.trim() }, onLongClick = null)
        for (s in items) Chip(s, Void.text, onClick = { Haptics.tick(ctx); onPick(s) }, onLongClick = { deleting = s })
    }
    adding?.let { start ->
        var text by remember { mutableStateOf(start) }
        AlertDialog(
            onDismissRequest = { adding = null },
            title = { Text(tr("Save a snippet")) },
            text = { OutlinedTextField(value = text, onValueChange = { text = it.take(Snippets.MAX_LENGTH) }, minLines = 3, placeholder = { Text(tr("A prompt you use often")) }) },
            confirmButton = { TextButton(onClick = { Snippets.save(text); adding = null }, enabled = text.isNotBlank()) { Text(tr("Save")) } },
            dismissButton = { TextButton(onClick = { adding = null }) { Text(tr("Cancel")) } },
        )
    }
    deleting?.let { s ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text(tr("Delete this snippet?")) },
            text = { Text(s, maxLines = 6, overflow = TextOverflow.Ellipsis) },
            confirmButton = { TextButton(onClick = { Snippets.remove(s); deleting = null }) { Text(tr("Delete"), color = Void.bad) } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text(tr("Keep")) } },
        )
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun Chip(text: String, color: androidx.compose.ui.graphics.Color, onClick: () -> Unit, onLongClick: (() -> Unit)?) {
    Text(
        text,
        color = color,
        fontSize = 12.sp,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .widthIn(max = 220.dp)
            .clip(RoundedCornerShape(50))
            .background(Void.panelAlt)
            .border(1.dp, Void.border, RoundedCornerShape(50))
            .combinedClickable(onClick = onClick, onLongClick = onLongClick)
            .padding(horizontal = 10.dp, vertical = 6.dp),
    )
}

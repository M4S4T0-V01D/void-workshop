package dev.m4s4t0.voidportal.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.m4s4t0.voidportal.I18n
import dev.m4s4t0.voidportal.tr

/** "Phone language" and every bundled language, each in its own name; the choice applies at once. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun LanguageChips() {
    val ctx = LocalContext.current
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        FilterChip(selected = I18n.preference == "", onClick = { I18n.set(ctx, "") }, label = { Text(tr("Phone language")) })
        for (l in I18n.LANGUAGES) FilterChip(selected = I18n.preference == l.code, onClick = { I18n.set(ctx, l.code) }, label = { Text(l.name) })
    }
}

/** Shown once, after the opening animation, until a language is picked. */
@Composable
fun WelcomeLanguage() {
    val ctx = LocalContext.current
    Box(Modifier.fillMaxSize().background(Void.bg.copy(alpha = 0.96f)).clickable(enabled = false) {}) {
        Column(
            Modifier.fillMaxSize().systemBarsPadding().padding(24.dp).verticalScroll(rememberScrollState()),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            PortalLogo(Modifier.size(96.dp))
            Spacer(Modifier.height(12.dp))
            Text(tr("Choose your language"), fontSize = 22.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Center)
            Text(
                tr("You can change it later in Settings → Language."),
                color = Void.dim,
                textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 6.dp, bottom = 16.dp),
            )
            LanguageChips()
            Spacer(Modifier.height(20.dp))
            Button(onClick = { I18n.set(ctx, I18n.preference) }, modifier = Modifier.fillMaxWidth().height(50.dp)) { Text(tr("Continue")) }
        }
    }
}

package dev.m4s4t0.voidportal

import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.ExperimentalGlanceRemoteViewsApi
import androidx.glance.appwidget.compose
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Renders the home screen widget from a saved snapshot, as a launcher would, in two themes, and keeps pictures. */
@RunWith(AndroidJUnit4::class)
class WidgetRenderTest {
    @OptIn(ExperimentalGlanceRemoteViewsApi::class)
    @Test
    fun rendersUsageApprovalsAndChatsInTheAppTheme() {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        // Let the app's own first widget save (made at start-up, before this data existed) land first.
        Thread.sleep(2500)
        val now = System.currentTimeMillis()
        ctx.getSharedPreferences("portal_widget", 0).edit().putString(
            "snapshot",
            """{"pc":"workstation","status":"Online","online":true,"savedAt":$now,
              "plan":{"rows":[{"kind":"session","label":"5-hour session","percent":7,"severity":"normal"},
                              {"kind":"weekly_all","label":"Weekly","percent":32,"severity":"normal"},
                              {"kind":"weekly_scoped","label":"Fable limit","percent":81,"severity":"warning"}]},
              "approvals":[{"id":"a1","taskId":"t1","summary":"Run: ./gradlew assembleRelease"}],
              "tasks":[{"id":"t1","title":"Fix the launcher app picker","state":"executing","project":"void-launcher","summary":null},
                       {"id":"t2","title":"Plan usage meter","state":"idle","project":"void-workshop","summary":"Added the 5-hour, weekly and Fable meters to the status bar and Portal."},
                       {"id":"t3","title":"Release Portal","state":"completed","project":"void-workshop","summary":"Portal 1.6.0 is out."}]}""",
        ).commit()
        for (theme in listOf("void", "ember")) {
            ctx.getSharedPreferences("ui", 0).edit().putString("theme", theme).commit()
            Themes.init(ctx)
            val views = runBlocking { PortalWidget().compose(ctx, size = DpSize(320.dp, 380.dp)) }
            val density = ctx.resources.displayMetrics.density
            val w = (320 * density).toInt()
            val h = (380 * density).toInt()
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                val host = FrameLayout(ctx)
                host.addView(views.apply(ctx, host))
                host.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
                host.layout(0, 0, w, h)
                val texts = mutableListOf<String>().also { collect(host, it) }
                for (want in listOf("Fable 81%", "Needs you", "Fix the launcher app picker", "Working…", "Plan usage meter", "Release Portal"))
                    assertTrue("missing \"$want\" in $texts", texts.any { it.contains(want) })
                val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                host.draw(Canvas(bmp))
                File(ctx.getExternalFilesDir(null), "widget-$theme.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
            }
        }
    }

    private fun collect(v: View, out: MutableList<String>) {
        if (v is TextView) out += v.text.toString()
        if (v is ViewGroup) for (i in 0 until v.childCount) collect(v.getChildAt(i), out)
    }
}

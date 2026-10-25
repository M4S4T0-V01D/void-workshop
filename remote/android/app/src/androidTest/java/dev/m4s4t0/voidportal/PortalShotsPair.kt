package dev.m4s4t0.voidportal

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Opt-in, for the README screenshots (see Screenshots in remote/README.md): pairs the app with the demo PC from
 * sidecar/test/portal-shots.test.ts over a loopback relay, which a scanned code can't do (wss only).
 * Skipped unless run with -e portalShotsRelay ws://127.0.0.1:8787 -e portalShotsSecret <hex>.
 */
@RunWith(AndroidJUnit4::class)
class PortalShotsPair {
    @Test
    fun pairWithDemoPc() {
        val args = InstrumentationRegistry.getArguments()
        val relay = args.getString("portalShotsRelay")
        val secret = args.getString("portalShotsSecret")
        assumeTrue(relay != null && secret != null)
        val bytes = secret!!.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val inst = InstrumentationRegistry.getInstrumentation()
        inst.runOnMainSync {
            Portal.init(inst.targetContext)
            Portal.pair(Pairing(relay!!, bytes, "Workstation"))
        }
        // The pairing is saved with apply(); give it time to reach disk before the test process ends.
        Thread.sleep(3_000)
    }
}

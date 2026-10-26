package dev.m4s4t0.voidportal.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.m4s4t0.voidportal.arr
import dev.m4s4t0.voidportal.bool
import dev.m4s4t0.voidportal.num
import dev.m4s4t0.voidportal.str
import kotlinx.serialization.json.JsonObject
import dev.m4s4t0.voidportal.tr

sealed interface TItem {
    val key: Int
}

data class TUser(override val key: Int, val text: String) : TItem
data class TAgent(override val key: Int, val text: String) : TItem
data class TTool(override val key: Int, val id: String, val name: String, val summary: String, val status: String, val result: String?) : TItem
data class TNotice(override val key: Int, val level: String, val text: String) : TItem
data class TPlan(override val key: Int, val text: String) : TItem
/** A picture the agent looked at; only its name and size come with the chat, the pixels on request. */
data class TImage(override val key: Int, val imageId: String, val name: String, val bytes: Double) : TItem

/** Things someone said: what the jump buttons stop at. */
fun TItem.isMessage() = this is TUser || this is TAgent || this is TPlan

/**
 * Where the jump buttons go, given the list positions of the messages (sorted) and the first visible row.
 * Up goes to the start of the message on screen when it is scrolled into, else to the one before it.
 */
fun jumpUp(messages: List<Int>, first: Int, offset: Int): Int? =
    messages.lastOrNull { it < first || (it == first && offset > 0) }

fun jumpDown(messages: List<Int>, first: Int): Int? = messages.firstOrNull { it > first }

/** A task's conversation, rebuilt from saved events and kept current from live ones (mirrors src/timeline.ts). */
class Timeline {
    val items = mutableStateListOf<TItem>()
    var streaming by mutableStateOf("")
    var plan by mutableStateOf<List<JsonObject>>(emptyList())
    private var next = 0

    fun clear() {
        items.clear()
        streaming = ""
        plan = emptyList()
    }

    private fun push(make: (Int) -> TItem) {
        items += make(next++)
    }

    private fun notice(level: String, text: String) = push { TNotice(it, level, text) }

    fun apply(kind: String, p: JsonObject) {
        when (kind) {
            "user", "agent.user" -> {
                val text = p.str("text") ?: ""
                // The planning marker is for the agent, not worth showing.
                push { TUser(it, text.substringBefore("\n\n[VOID Workshop:").ifBlank { text }) }
            }
            "assistant", "agent.text" -> if (p.bool("sub") != true) {
                push { TAgent(it, p.str("text") ?: "") }
                streaming = ""
            }
            "agent.delta" -> streaming += p.str("text") ?: ""
            "agent.messageStart" -> streaming = ""
            "tool", "agent.tool" -> {
                val name = p.str("name") ?: ""
                if (name !in setOf("TodoWrite", "TaskList", "TaskGet")) {
                    push { TTool(it, p.str("id") ?: "", name, p.str("summary") ?: name, "running", null) }
                    streaming = ""
                }
            }
            "tool.result", "agent.toolResult" -> {
                val id = p.str("id")
                val i = items.indexOfFirst { it is TTool && it.id == id }
                if (i >= 0) {
                    val t = items[i] as TTool
                    items[i] = t.copy(status = if (p.bool("isError") == true) "error" else "ok", result = p.str("text"))
                }
            }
            "image", "agent.image" -> p.str("imageId")?.let { id -> push { TImage(it, id, p.str("name") ?: "image", p.num("bytes") ?: 0.0) } }
            "plan", "agent.plan" -> {
                push { TPlan(it, p.str("text") ?: "") }
                p.arr("items").takeIf { it.isNotEmpty() }?.let { plan = it }
                streaming = ""
            }
            "todos", "agent.todos" -> plan = p.arr("items")
            "agent.notice" -> notice(p.str("level") ?: "info", p.str("text") ?: "")
            "stopped" -> notice(if (p.str("state") == "stopped-budget" || p.str("state") == "stopped-limit") "warn" else "error", p.str("message") ?: tr("Stopped"))
            "approval.resolved" -> if (p.str("summary") != null) {
                val auto = p.bool("auto") == true
                val summary = "summary" to p.str("summary")
                val text = if (auto) tr("Auto-approved: {summary}", summary) else if (p.str("decision") == "allow") tr("Approved: {summary}", summary) else tr("Denied: {summary}", summary)
                notice(if (p.str("decision") == "allow") "info" else "warn", text)
            }
            "agent.autoApproved" -> notice("info", tr("Auto-approved: {summary}", "summary" to (p.str("summary") ?: "")))
            "policy.denied", "agent.policyDenied" -> notice("warn", tr("Blocked {tool}: {reason}", "tool" to (p.str("tool") ?: ""), "reason" to (p.str("reason") ?: "")))
            "auth.switched" -> notice("warn", if (p.str("to") == "subscription") tr("Switched to your Claude plan.") else tr("Switched to your API key."))
            "agent.retry" -> notice("warn", tr("API retry: {error}", "error" to (p.str("error") ?: "")))
            "compact" -> notice("info", tr("Compacting the conversation to save tokens."))
        }
    }
}

package dev.m4s4t0.voidportal

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull

fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
fun JsonObject.arr(key: String): List<JsonObject> = (this[key] as? JsonArray)?.filterIsInstance<JsonObject>() ?: emptyList()
fun JsonObject.strs(key: String): List<String> =
    (this[key] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList()
fun JsonObject.num(key: String): Double? = (this[key] as? JsonPrimitive)?.doubleOrNull
fun JsonObject.bool(key: String): Boolean? = (this[key] as? JsonPrimitive)?.booleanOrNull

/** Small builder for call parameters: values may be String, Number, Boolean, null or JsonElement. */
fun json(vararg pairs: Pair<String, Any?>): JsonObject = JsonObject(pairs.associate { (k, v) -> k to toJson(v) })

private fun toJson(v: Any?): JsonElement = when (v) {
    null -> JsonNull
    is JsonElement -> v
    is String -> JsonPrimitive(v)
    is Number -> JsonPrimitive(v)
    is Boolean -> JsonPrimitive(v)
    else -> JsonPrimitive(v.toString())
}

class PortalError(val code: String, message: String) : Exception(message)

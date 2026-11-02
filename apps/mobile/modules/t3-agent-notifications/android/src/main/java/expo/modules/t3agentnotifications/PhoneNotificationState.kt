package expo.modules.t3agentnotifications

import android.content.SharedPreferences
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/** Shell snapshots replay on reconnect; history must outlive both the socket and JS. */
internal class PhoneNotificationState(private val prefs: SharedPreferences) {
  data class Alert(val id: String, val title: String, val body: String, val seenKey: String, val value: String)
  data class Decision(val alerts: List<Alert>, val clear: List<String>)

  fun thread(environment: String, thread: JSONObject, since: Long): Decision {
    val key = "$environment/${thread.getString("id") }"
    val pending = thread.optJSONObject("pendingRuntimeRequest")
    val request = pending?.optString("id")?.takeIf { it.isNotEmpty() }
    val previousRequest = prefs.getString("pending:$key", null)
    val clear = if (previousRequest != null && previousRequest != request) {
      listOf("phone:request:$key:$previousRequest")
    } else emptyList()
    val alerts = mutableListOf<Alert>()
    val hidden = !thread.isNull("archivedAt") || !thread.isNull("deletedAt")
    val editor = prefs.edit()
    if (!hidden && request != null && prefs.getString("seen-request:$key", null) != request) {
      alerts.add(Alert("phone:request:$key:$request", thread.optString("title"),
        if (pending.optString("kind") == "user_input") "Your agent needs input" else "Your agent needs approval", "seen-request:$key", request))
    }
    val run = thread.optString("latestRunId").takeUnless { it == "null" || it.isEmpty() }
    val completed = listOf("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'")
      .firstNotNullOfOrNull { pattern ->
        runCatching { SimpleDateFormat(pattern, Locale.ROOT).apply {
          timeZone = TimeZone.getTimeZone("UTC")
          isLenient = false
        }.parse(thread.optString("latestRunCompletedAt"))?.time }.getOrNull()
      }
    // Subagent runs finish inside their parent's turn; the parent's completion is the one to report.
    val subagent = thread.optJSONObject("lineage")?.optString("relationshipToParent") == "subagent"
    if (!hidden && !subagent && run != null && completed != null && completed >= since &&
      thread.optString("status") in setOf("completed", "failed", "interrupted", "cancelled", "rolled_back") &&
      prefs.getString("seen-run:$key", null) != run) {
      alerts.add(Alert("phone:run:$key", thread.optString("title"),
        if (thread.optString("status") == "completed") "Turn finished" else "Turn ${thread.optString("status")}", "seen-run:$key", run))
    }
    if (request == null || hidden) editor.remove("pending:$key") else editor.putString("pending:$key", request)
    editor.apply()
    return Decision(alerts, clear + if (hidden && request != null) listOf("phone:request:$key:$request") else emptyList())
  }

  fun posted(alert: Alert) {
    prefs.edit().putString(alert.seenKey, alert.value).apply()
  }

  fun remove(environment: String, threadId: String, preserveRun: Boolean = false): List<String> {
    val key = "$environment/$threadId"
    val request = prefs.getString("pending:$key", null)
    val run = prefs.getString("seen-run:$key", null)
    prefs.edit().remove("pending:$key").remove("seen-request:$key").apply {
      if (!preserveRun) remove("seen-run:$key")
    }.apply()
    return listOfNotNull(request?.let { "phone:request:$key:$it" }, run?.takeUnless { preserveRun }?.let { "phone:run:$key" })
  }

  private fun threadKeys(): Set<String> = prefs.all.keys.mapNotNull { key ->
    listOf("pending:", "seen-request:", "seen-run:").firstOrNull { key.startsWith(it) }?.let { key.removePrefix(it) }
  }.toSet()

  fun reconcile(environment: String, ids: Set<String>, preserveRuns: Boolean = false): List<String> = threadKeys()
    .filter { it.startsWith("$environment/") && it.removePrefix("$environment/") !in ids }
    .flatMap { remove(environment, it.removePrefix("$environment/"), preserveRuns) }

  fun retainEnvironments(environments: Set<String>) {
    threadKeys().filter { it.substringBefore('/') !in environments }.forEach {
      remove(it.substringBefore('/'), it.substringAfter('/'))
    }
  }
}

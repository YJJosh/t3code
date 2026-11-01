package expo.modules.t3agentnotifications

import android.content.SharedPreferences
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/** Shell snapshots replay on reconnect; history must outlive both the socket and JS. */
internal class PhoneNotificationState(private val prefs: SharedPreferences) {
  data class Alert(val id: String, val title: String, val body: String)
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
        if (pending.optString("kind") == "user_input") "Your agent needs input" else "Your agent needs approval"))
      editor.putString("seen-request:$key", request)
    }
    val run = thread.optString("latestRunId").takeUnless { it == "null" || it.isEmpty() }
    val completed = listOf("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", "yyyy-MM-dd'T'HH:mm:ss'Z'")
      .firstNotNullOfOrNull { pattern ->
        runCatching { SimpleDateFormat(pattern, Locale.ROOT).apply {
          timeZone = TimeZone.getTimeZone("UTC")
          isLenient = false
        }.parse(thread.optString("latestRunCompletedAt"))?.time }.getOrNull()
      }
    if (!hidden && run != null && completed != null && completed >= since &&
      thread.optString("status") in setOf("completed", "failed", "interrupted", "cancelled", "rolled_back") &&
      prefs.getString("seen-run:$key", null) != run) {
      alerts.add(Alert("phone:run:$key:$run", thread.optString("title"),
        if (thread.optString("status") == "completed") "Turn finished" else "Turn ${thread.optString("status")}"))
      editor.putString("seen-run:$key", run)
    }
    if (request == null || hidden) editor.remove("pending:$key") else editor.putString("pending:$key", request)
    editor.apply()
    return Decision(alerts, clear + if (hidden && request != null) listOf("phone:request:$key:$request") else emptyList())
  }

  fun remove(environment: String, threadId: String): List<String> {
    val key = "$environment/$threadId"
    val request = prefs.getString("pending:$key", null) ?: return emptyList()
    prefs.edit().remove("pending:$key").apply()
    return listOf("phone:request:$key:$request")
  }

  fun reconcile(environment: String, ids: Set<String>): List<String> = prefs.all.keys
    .filter { it.startsWith("pending:$environment/") && it.removePrefix("pending:$environment/") !in ids }
    .flatMap { remove(environment, it.removePrefix("pending:$environment/")) }
}

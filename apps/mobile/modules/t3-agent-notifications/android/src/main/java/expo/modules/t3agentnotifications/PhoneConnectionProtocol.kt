package expo.modules.t3agentnotifications

import android.net.Uri
import org.json.JSONObject

internal fun phoneSocketUrl(config: JSONObject, ticket: String): String {
  val uri = Uri.parse(config.getString("wsBaseUrl"))
  return uri.buildUpon().apply {
    if (uri.path.isNullOrEmpty() || uri.path == "/") path("/ws")
  }.appendQueryParameter("wsTicket", ticket)
    .appendQueryParameter(
      "orchestrationProtocol",
      maxOf(
        config.optInt("protocolVersion", 0),
        BuildConfig.ORCHESTRATION_PROTOCOL_VERSION
      ).toString()
    )
    .appendQueryParameter("clientSurface", "mobile")
    .appendQueryParameter("clientDeviceType", "phone").build().toString()
}

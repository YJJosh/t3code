package expo.modules.t3agentnotifications

import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import android.app.NotificationManager
import android.os.Looper
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.concurrent.ExecutorService

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26], manifest = Config.NONE)
class PhoneShellProtocolTest {
  @Test fun shellSubscriptionOnlyUsesAdvertisedFiltersAndConsumesTheContractFixture() {
    for (families in listOf(false, true)) for (older in listOf(false, true)) {
      val context = RuntimeEnvironment.getApplication()
      PhoneConnectionStore.preferences(context).edit().clear().putBoolean("enabled", true).putLong("since", 0).commit()
      val controller = Robolectric.buildService(PhoneConnectionService::class.java).create()
      try {
        val manager = context.getSystemService(NotificationManager::class.java)
        shadowOf(manager).setNotificationsEnabled(true)
        val service = controller.get()
        service.onStartCommand(null, 0, 1)
        val clazz = PhoneConnectionService::class.java.declaredClasses.single { it.simpleName == "Connection" }
        val connection = clazz.declaredConstructors.single().apply { isAccessible = true }
          .newInstance(service, JSONObject().put("environmentId", "env"))
        val listener = clazz.getDeclaredMethod("listener", Int::class.javaPrimitiveType).apply { isAccessible = true }
          .invoke(connection, 0) as WebSocketListener
        val fixture = JSONObject(javaClass.classLoader!!.getResource("phone-shell.json")!!.readText())
        val sent = mutableListOf<JSONObject>()
        val socket = java.lang.reflect.Proxy.newProxyInstance(WebSocket::class.java.classLoader,
          arrayOf(WebSocket::class.java)) { _, method, args ->
          if (method.name == "send") { sent.add(JSONObject(args!![0] as String)); true } else null
        } as WebSocket
        listener.onOpen(socket, Response.Builder().request(Request.Builder().url("http://fixture.test").build())
          .protocol(Protocol.HTTP_1_1).code(101).message("Upgrade").build())
        shadowOf(Looper.getMainLooper()).idle()
        assertEquals(fixture.getJSONObject("methods").getString("config"), sent.single().getString("tag"))
        listener.onMessage(socket, JSONObject().put("_tag", "Exit").put("requestId", "phone-config")
          .put("exit", JSONObject().put("_tag", "Success").put("value", JSONObject()
            .put("shellThreadFamilies", families).put("shellOlderSettled", older))).toString())
        val parser = PhoneConnectionService::class.java.getDeclaredField("parser").apply { isAccessible = true }
          .get(service) as ExecutorService
        parser.submit {}.get()
        shadowOf(Looper.getMainLooper()).idle()
        val subscription = sent.last()
        assertEquals(fixture.getJSONObject("methods").getString("shell"), subscription.getString("tag"))
        val payload = subscription.getJSONObject("payload")
        assertEquals(families, payload.optBoolean("omitIdleSubagents"))
        assertEquals(families && older, payload.optBoolean("omitOlderSettled"))
        if (!families) assertFalse(payload.has("omitIdleSubagents"))
        if (!families || !older) assertFalse(payload.has("omitOlderSettled"))
        val items = fixture.getJSONArray("items")
        for (index in 0 until items.length()) {
          listener.onMessage(socket, JSONObject().put("_tag", "Chunk").put("requestId", "phone-shell")
            .put("values", org.json.JSONArray().put(items.getJSONObject(index))).toString())
          parser.submit {}.get()
          shadowOf(Looper.getMainLooper()).idle()
          val alerts = manager.activeNotifications.filter { it.notification.group?.startsWith("phone:") == true }
          when (index) {
            0 -> assertEquals("Your agent needs input", alerts.single().notification.extras.getString("android.text"))
            1, 2 -> {
              assertEquals("phone:run:env/thread", alerts.single().notification.group)
              assertEquals("Turn finished", alerts.single().notification.extras.getString("android.text"))
            }
            3 -> assertTrue(alerts.isEmpty())
          }
          assertEquals("Ack", sent.last().getString("_tag"))
        }
      } finally { controller.destroy() }
    }
  }
}

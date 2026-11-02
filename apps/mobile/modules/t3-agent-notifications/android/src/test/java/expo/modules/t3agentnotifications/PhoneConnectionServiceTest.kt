package expo.modules.t3agentnotifications

import android.app.NotificationManager
import android.app.Service
import android.os.Looper
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import java.util.concurrent.CountDownLatch
import org.json.JSONArray
import org.json.JSONObject
import org.robolectric.Shadows.shadowOf
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [24, 26, 33, 36], manifest = Config.NONE)
class PhoneConnectionServiceTest {
  @Test fun aFreshInstallNeverStartsTheForegroundConnection() {
    val context = RuntimeEnvironment.getApplication()
    PhoneConnectionStore.preferences(context).edit().clear().commit()
    val controller = Robolectric.buildService(PhoneConnectionService::class.java).create()
    try {
      assertEquals(Service.START_NOT_STICKY, controller.get().onStartCommand(null, 0, 1))
      assertFalse(PhoneConnectionService.active)
      assertTrue(context.getSystemService(NotificationManager::class.java).activeNotifications.isEmpty())
    } finally { controller.destroy() }
  }

  @Test fun oldServersFallBackToTheBareTicketRouteButAuthFailuresDoNot() {
    val context = RuntimeEnvironment.getApplication()
    for (status in listOf(404, 401)) {
      PhoneConnectionStore.preferences(context).edit().clear().putBoolean("enabled", true).commit()
      val controller = Robolectric.buildService(PhoneConnectionService::class.java).create()
      try {
        val service = controller.get()
        val completed = CountDownLatch(1)
        val client = OkHttpClient.Builder().addInterceptor { chain ->
          Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
            .code(status).message("fixture").body("{}".toResponseBody()).build()
        }.build()
        client.dispatcher.idleCallback = Runnable { completed.countDown() }
        PhoneConnectionService::class.java.getDeclaredField("client").apply { isAccessible = true }.set(service, client)
        service.onStartCommand(null, 0, 1)
        val connectionClass = PhoneConnectionService::class.java.declaredClasses.single { it.simpleName == "Connection" }
        val connection = connectionClass.declaredConstructors.single().apply { isAccessible = true }
          .newInstance(service, JSONObject().put("environmentId", "env")
            .put("httpBaseUrl", "http://server.test/proxy").put("token", "fixture-token"))
        connectionClass.getDeclaredMethods().single { it.name == "connect" }.apply { isAccessible = true }
          .invoke(connection, false)
        completed.await()
        shadowOf(Looper.getMainLooper()).idle()
        val ticketCall = connectionClass.getDeclaredField("ticketCall").apply { isAccessible = true }.get(connection) as Call
        assertEquals(if (status == 404) "/proxy/api/auth/websocket-ticket" else "/proxy/api/auth/websocket-ticket/rpc",
          ticketCall.request().url.encodedPath)
        assertEquals("Bearer fixture-token", ticketCall.request().header("Authorization"))
        connectionClass.getDeclaredMethod("close").apply { isAccessible = true }.invoke(connection)
      } finally { controller.destroy() }
    }
  }

  @Test fun enrichmentSnapshotsCannotClearAnUnansweredRequest() {
    val context = RuntimeEnvironment.getApplication()
    PhoneConnectionStore.preferences(context).edit().clear().putBoolean("enabled", true).commit()
    val manager = context.getSystemService(NotificationManager::class.java)
    shadowOf(manager).setNotificationsEnabled(true)
    val controller = Robolectric.buildService(PhoneConnectionService::class.java).create()
    try {
      val service = controller.get()
      service.onStartCommand(null, 0, 1)
      val connectionClass = PhoneConnectionService::class.java.declaredClasses.single { it.simpleName == "Connection" }
      val connection = connectionClass.declaredConstructors.single().apply { isAccessible = true }
        .newInstance(service, JSONObject().put("environmentId", "env"))
      val receive = connectionClass.getDeclaredMethod("receive", JSONObject::class.java).apply { isAccessible = true }
      val thread = JSONObject().put("id", "thread").put("title", "Pending question")
        .put("archivedAt", JSONObject.NULL).put("deletedAt", JSONObject.NULL)
        .put("pendingRuntimeRequest", JSONObject().put("id", "question").put("kind", "user_input"))
      val snapshot = JSONObject().put("kind", "snapshot")
        .put("snapshot", JSONObject().put("threads", JSONArray().put(thread)))
      receive.invoke(connection, snapshot)
      val alertId = "phone:request:env/thread:question".hashCode()
      assertTrue(manager.activeNotifications.any { it.id == alertId })
      receive.invoke(connection, JSONObject().put("kind", "snapshot")
        .put("resolvedRepositoryIdentityRoots", JSONArray().put("/workspace"))
        .put("snapshot", JSONObject().put("threads", JSONArray())))
      assertTrue(manager.activeNotifications.any { it.id == alertId })
      receive.invoke(connection, snapshot)
      assertEquals(1, manager.activeNotifications.count { it.id == alertId })
      receive.invoke(connection, JSONObject().put("kind", "snapshot")
        .put("snapshot", JSONObject().put("threads", JSONArray())))
      assertFalse(manager.activeNotifications.any { it.id == alertId })
    } finally { controller.destroy() }
  }

  @Test fun optedInServiceStartsWithALowPriorityPersistentNotificationOnEverySupportedApi() {
    val context = RuntimeEnvironment.getApplication()
    PhoneConnectionStore.preferences(context).edit().clear().putBoolean("enabled", true).commit()
    val controller = Robolectric.buildService(PhoneConnectionService::class.java).create()
    try {
      assertEquals(Service.START_STICKY, controller.get().onStartCommand(null, 0, 1))
      assertTrue(PhoneConnectionService.active)
      val notification = context.getSystemService(NotificationManager::class.java).activeNotifications.single()
      assertEquals(73002, notification.id)
      assertEquals("Dulli connected", notification.notification.extras.getString("android.title"))
      assertEquals(android.app.Notification.PRIORITY_LOW, notification.notification.priority)
      assertTrue(notification.notification.flags and android.app.Notification.FLAG_ONGOING_EVENT != 0)
    } finally { controller.destroy() }
  }

  @Test fun pairedCredentialsAreOnlyKeptWhileOptedIn() {
    val context = RuntimeEnvironment.getApplication()
    val prefs = PhoneConnectionStore.preferences(context)
    prefs.edit().clear().commit()
    PhoneConnectionStore.save(context, "[{\"environmentId\":\"env\",\"token\":\"secret\"}]", "t3dulli")
    assertFalse(prefs.contains("connections"))

    prefs.edit().putBoolean("enabled", true).putString("connections", "encrypted").commit()
    PhoneConnectionService.setEnabled(context, false)
    assertFalse(prefs.contains("connections"))
  }
}

package expo.modules.t3agentnotifications

import android.app.NotificationManager
import android.app.Service
import android.net.ConnectivityManager
import android.net.Network
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import android.os.Looper
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ProcessLifecycleOwner
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import java.util.concurrent.CountDownLatch
import org.json.JSONArray
import org.json.JSONObject
import org.robolectric.Shadows.shadowOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
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
      assertTrue(
        context.getSystemService(NotificationManager::class.java).activeNotifications.isEmpty()
      )
    } finally {
      controller.destroy()
    }
  }

  @Suppress("NestedBlockDepth")
  @Test
  fun oldServersFallBackToTheBareTicketRouteButAuthFailuresDoNot() {
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
        PhoneConnectionService::class.java.getDeclaredField("client").apply {
          isAccessible = true
        }.set(service, client)
        service.onStartCommand(null, 0, 1)
        val connectionClass = PhoneConnectionService::class.java.declaredClasses.single {
          it.simpleName ==
            "Connection"
        }
        val connection = connectionClass.declaredConstructors.single().apply { isAccessible = true }
          .newInstance(
            service,
            JSONObject().put("environmentId", "env")
              .put("httpBaseUrl", "http://server.test/proxy").put("token", "fixture-token")
          )
        connectionClass.getDeclaredMethods().single { it.name == "connect" }.apply {
          isAccessible =
            true
        }
          .invoke(connection, false)
        val connections = PhoneConnectionService::class.java.getDeclaredField("connections").apply {
          isAccessible =
            true
        }
          .get(service) as MutableList<Any>
        connections.add(connection)
        completed.await()
        shadowOf(Looper.getMainLooper()).idle()
        val ticketCall = connectionClass.getDeclaredField("ticketCall").apply {
          isAccessible = true
        }.get(connection) as Call
        assertEquals(
          if (status ==
            404
          ) {
            "/proxy/api/auth/websocket-ticket"
          } else {
            "/proxy/api/auth/websocket-ticket/rpc"
          },
          ticketCall.request().url.encodedPath
        )
        assertEquals("Bearer fixture-token", ticketCall.request().header("Authorization"))
        if (status == 401) {
          assertEquals(
            "Re-pair env in Dulli",
            context.getSystemService(NotificationManager::class.java)
              .activeNotifications.single().notification.extras.getString("android.text")
          )
          connectionClass.getDeclaredMethods().single { it.name == "connect" }.apply {
            isAccessible =
              true
          }
            .invoke(connection, false)
          assertSame(
            ticketCall,
            connectionClass.getDeclaredField("ticketCall").apply {
              isAccessible =
                true
            }.get(connection)
          )
        }
        connectionClass.getDeclaredMethod("close").apply { isAccessible = true }.invoke(connection)
      } finally {
        controller.destroy()
      }
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
      val connectionClass = PhoneConnectionService::class.java.declaredClasses.single {
        it.simpleName ==
          "Connection"
      }
      val connection = connectionClass.declaredConstructors.single().apply { isAccessible = true }
        .newInstance(service, JSONObject().put("environmentId", "env"))
      val receive = connectionClass.getDeclaredMethod("receive", JSONObject::class.java).apply {
        isAccessible =
          true
      }
      val thread = JSONObject().put("id", "thread").put("title", "Pending question")
        .put("archivedAt", JSONObject.NULL).put("deletedAt", JSONObject.NULL)
        .put("pendingRuntimeRequest", JSONObject().put("id", "question").put("kind", "user_input"))
      val snapshot = JSONObject().put("kind", "snapshot")
        .put("snapshot", JSONObject().put("threads", JSONArray().put(thread)))
      receive.invoke(connection, snapshot)
      val alertId = "phone:request:env/thread:question".hashCode()
      assertTrue(manager.activeNotifications.any { it.id == alertId })
      receive.invoke(
        connection,
        JSONObject().put("kind", "snapshot")
          .put("resolvedRepositoryIdentityRoots", JSONArray().put("/workspace"))
          .put("snapshot", JSONObject().put("threads", JSONArray()))
      )
      assertTrue(manager.activeNotifications.any { it.id == alertId })
      receive.invoke(connection, snapshot)
      assertEquals(1, manager.activeNotifications.count { it.id == alertId })
      receive.invoke(
        connection,
        JSONObject().put("kind", "snapshot")
          .put("snapshot", JSONObject().put("threads", JSONArray()))
      )
      assertFalse(manager.activeNotifications.any { it.id == alertId })
    } finally {
      controller.destroy()
    }
  }

  @Test fun defaultNetworkReturnReconnectsImmediatelyAndStopUnregisters() {
    val context = RuntimeEnvironment.getApplication()
    PhoneConnectionStore.preferences(context).edit().clear().putBoolean("enabled", true).commit()
    val controller = Robolectric.buildService(PhoneConnectionService::class.java).create()
    val connectivity = shadowOf(context.getSystemService(ConnectivityManager::class.java))
    val release = CountDownLatch(1)
    try {
      val service = controller.get()
      service.onStartCommand(null, 0, 1)
      service.onStartCommand(null, 0, 2)
      val client = OkHttpClient.Builder().addInterceptor {
        release.await()
        throw java.io.IOException("fixture offline")
      }.build()
      PhoneConnectionService::class.java.getDeclaredField("client").apply {
        isAccessible = true
      }.set(service, client)
      assertEquals(1, connectivity.networkCallbacks.size)
      val clazz = PhoneConnectionService::class.java.declaredClasses.single {
        it.simpleName ==
          "Connection"
      }
      val connection = clazz.declaredConstructors.single().apply { isAccessible = true }
        .newInstance(
          service,
          JSONObject().put("environmentId", "env")
            .put("httpBaseUrl", "http://127.0.0.1:1").put("token", "fixture")
        )
      val connections = PhoneConnectionService::class.java.getDeclaredField("connections").apply {
        isAccessible =
          true
      }
        .get(service) as MutableList<Any>
      connections.add(connection)
      val attempt = clazz.getDeclaredField("attempt").apply { isAccessible = true }
      attempt.setInt(connection, 6)
      connectivity.networkCallbacks.single().onAvailable(
        org.robolectric.shadows.ShadowNetwork.newInstance(42)
      )
      shadowOf(Looper.getMainLooper()).idle()
      assertEquals(0, attempt.getInt(connection))
      assertNotNull(
        clazz.getDeclaredField("ticketCall").apply {
          isAccessible = true
        }.get(connection)
      )
    } finally {
      controller.destroy()
      release.countDown()
    }
    assertTrue(connectivity.networkCallbacks.isEmpty())
  }

  @Test fun protocolRejectionShowsAnUpdateStatusAndRetriesSlowly() {
    val context = RuntimeEnvironment.getApplication()
    PhoneConnectionStore.preferences(context).edit().clear().putBoolean("enabled", true).commit()
    val controller = Robolectric.buildService(PhoneConnectionService::class.java).create()
    try {
      val service = controller.get()
      service.onStartCommand(null, 0, 1)
      val clazz = PhoneConnectionService::class.java.declaredClasses.single {
        it.simpleName ==
          "Connection"
      }
      val connection = clazz.declaredConstructors.single().apply { isAccessible = true }
        .newInstance(
          service,
          JSONObject().put("environmentId", "env").put("label", "My server")
            .put("httpBaseUrl", "http://127.0.0.1:1").put("token", "fixture")
        )
      val connections = PhoneConnectionService::class.java.getDeclaredField("connections").apply {
        isAccessible =
          true
      }
        .get(service) as MutableList<Any>
      connections.add(connection)
      val listener = clazz.getDeclaredMethod("listener", Int::class.javaPrimitiveType).apply {
        isAccessible =
          true
      }
        .invoke(connection, 0) as WebSocketListener
      val request = okhttp3.Request.Builder().url("http://server.test").build()
      val socket = java.lang.reflect.Proxy.newProxyInstance(
        WebSocket::class.java.classLoader,
        arrayOf(WebSocket::class.java)
      ) { _, _, _ -> null } as WebSocket
      listener.onFailure(
        socket,
        java.io.IOException("upgrade"),
        Response.Builder().request(request)
          .protocol(Protocol.HTTP_1_1).code(426).message("Update").build()
      )
      shadowOf(Looper.getMainLooper()).idle()
      val notification = context.getSystemService(
        NotificationManager::class.java
      ).activeNotifications.single()
      assertEquals(
        "Update Dulli or My server",
        notification.notification.extras.getString("android.text")
      )
      clazz.getDeclaredMethods().single {
        it.name == "connect"
      }.apply { isAccessible = true }.invoke(connection, false)
      assertNull(clazz.getDeclaredField("ticketCall").apply { isAccessible = true }.get(connection))
      // Either side may be the outdated one, so an upgraded server must be picked up without app action.
      shadowOf(Looper.getMainLooper()).idleFor(java.time.Duration.ofMinutes(15))
      assertNotNull(
        clazz.getDeclaredField("ticketCall").apply {
          isAccessible = true
        }.get(connection)
      )
      service.onStartCommand(null, 0, 2)
      assertEquals(
        "Pair a server to receive notifications",
        context.getSystemService(NotificationManager::class.java)
          .activeNotifications.single().notification.extras.getString("android.text")
      )
    } finally {
      controller.destroy()
    }
  }

  @Test fun refusedPostsRemainEligibleAndFinishedCardsReplacePerThreadWithABound() {
    val context = RuntimeEnvironment.getApplication()
    val prefs = PhoneConnectionStore.preferences(context)
    prefs.edit().clear().putBoolean("enabled", true).putLong("since", 0).commit()
    val manager = context.getSystemService(NotificationManager::class.java)
    shadowOf(manager).setNotificationsEnabled(false)
    val controller = Robolectric.buildService(PhoneConnectionService::class.java).create()
    try {
      val service = controller.get()
      service.onStartCommand(null, 0, 1)
      val clazz = PhoneConnectionService::class.java.declaredClasses.single {
        it.simpleName ==
          "Connection"
      }
      val connection = clazz.declaredConstructors.single().apply { isAccessible = true }
        .newInstance(service, JSONObject().put("environmentId", "env"))
      val receive = clazz.getDeclaredMethod("receive", JSONObject::class.java).apply {
        isAccessible =
          true
      }
      val thread = JSONObject().put("id", "thread").put("title", "Question")
        .put("pendingRuntimeRequest", JSONObject().put("id", "request").put("kind", "user_input"))
      fun update() {
        org.robolectric.shadows.ShadowSystemClock.advanceBy(java.time.Duration.ofSeconds(1))
        receive.invoke(connection, JSONObject().put("kind", "thread.updated").put("thread", thread))
      }
      update()
      val refusedWasSeen = prefs.contains("seen-request:env/thread")
      shadowOf(manager).setNotificationsEnabled(true)
      update()
      assertEquals("request", prefs.getString("seen-request:env/thread", null))
      val retriedRequestPosted = manager.activeNotifications.any {
        it.notification.group ==
          "phone:request:env/thread:request"
      }
      thread.put("pendingRuntimeRequest", JSONObject.NULL).put("status", "completed")
        .put("latestRunCompletedAt", "2026-01-01T00:00:00Z")
      for (run in listOf("one", "two")) {
        thread.put("latestRunId", run)
        update()
      }
      val sameThreadFinished = manager.activeNotifications.count {
        it.notification.group?.startsWith("phone:run:") ==
          true
      }
      for (index in 0..24) {
        thread.put("id", "other-$index").put("latestRunId", "run-$index")
        update()
      }
      val finished = manager.activeNotifications.filter {
        it.notification.group?.startsWith("phone:run:") ==
          true
      }
      assertEquals("per-thread=$sameThreadFinished; total=${finished.size}", 20, finished.size)
      assertEquals(1, sameThreadFinished)
      assertFalse(refusedWasSeen)
      assertTrue(retriedRequestPosted)
      assertFalse(finished.any { it.notification.group == "phone:run:env/thread" })
      thread.put(
        "id",
        "action"
      ).put("pendingRuntimeRequest", JSONObject().put("id", "new").put("kind", "command_approval"))
      update()
      assertTrue(
        manager.activeNotifications.any {
          it.notification.group ==
            "phone:request:env/action:new"
        }
      )
      shadowOf(manager).setEnforceMaxNotificationLimit(true)
      for (index in 0..24) manager.notify("unrelated", index, android.app.Notification())
      thread.put("id", "refused").put("latestRunId", JSONObject.NULL)
        .put("pendingRuntimeRequest", JSONObject().put("id", "refused").put("kind", "user_input"))
      update()
      assertFalse(prefs.contains("seen-request:env/refused"))
    } finally {
      controller.destroy()
    }
  }

  @Test fun completionViewedInTheThreadDoesNotAlertAfterABackgroundReplay() {
    val context = RuntimeEnvironment.getApplication()
    val prefs = PhoneConnectionStore.preferences(context)
    prefs.edit().clear().putBoolean("enabled", true).putLong("since", 0).commit()
    val manager = context.getSystemService(NotificationManager::class.java)
    shadowOf(manager).setNotificationsEnabled(true)
    val lifecycle = ProcessLifecycleOwner.get().lifecycle as LifecycleRegistry
    lifecycle.currentState = Lifecycle.State.RESUMED
    AgentNotifications.setThreadOnScreen("/threads/env/thread")
    val controller = Robolectric.buildService(PhoneConnectionService::class.java).create()
    try {
      val service = controller.get()
      service.onStartCommand(null, 0, 1)
      val clazz = PhoneConnectionService::class.java.declaredClasses.single {
        it.simpleName ==
          "Connection"
      }
      val connection = clazz.declaredConstructors.single().apply { isAccessible = true }
        .newInstance(service, JSONObject().put("environmentId", "env"))
      val receive = clazz.getDeclaredMethod("receive", JSONObject::class.java).apply {
        isAccessible =
          true
      }
      val thread = JSONObject().put(
        "id",
        "thread"
      ).put("title", "Viewed turn").put("status", "completed")
        .put("latestRunId", "viewed").put("latestRunCompletedAt", "2026-01-01T00:00:00Z")
      receive.invoke(connection, JSONObject().put("kind", "thread.updated").put("thread", thread))
      assertFalse(
        manager.activeNotifications.any {
          it.notification.group?.startsWith("phone:") ==
            true
        }
      )
      lifecycle.currentState = Lifecycle.State.CREATED
      receive.invoke(
        connection,
        JSONObject().put("kind", "snapshot")
          .put("snapshot", JSONObject().put("threads", JSONArray().put(thread)))
      )
      assertFalse(
        "An already-viewed completion must not alert on replay",
        manager.activeNotifications.any { it.notification.group?.startsWith("phone:") == true }
      )
      assertEquals("viewed", prefs.getString("seen-run:env/thread", null))
      thread.put("latestRunId", "new-background-turn")
      receive.invoke(connection, JSONObject().put("kind", "thread.updated").put("thread", thread))
      assertTrue(
        manager.activeNotifications.any {
          it.notification.group == "phone:run:env/thread"
        }
      )
    } finally {
      controller.destroy()
      lifecycle.currentState = Lifecycle.State.CREATED
      AgentNotifications.setThreadOnScreen(null)
    }
  }

  @Test fun optedInServiceStartsWithALowPriorityPersistentNotificationOnEverySupportedApi() {
    val context = RuntimeEnvironment.getApplication()
    PhoneConnectionStore.preferences(context).edit().clear().putBoolean("enabled", true).commit()
    val controller = Robolectric.buildService(PhoneConnectionService::class.java).create()
    try {
      assertEquals(Service.START_STICKY, controller.get().onStartCommand(null, 0, 1))
      assertTrue(PhoneConnectionService.active)
      val notification = context.getSystemService(
        NotificationManager::class.java
      ).activeNotifications.single()
      assertEquals(73002, notification.id)
      assertEquals("Dulli connected", notification.notification.extras.getString("android.title"))
      assertEquals(android.app.Notification.PRIORITY_LOW, notification.notification.priority)
      assertTrue(
        notification.notification.flags and android.app.Notification.FLAG_ONGOING_EVENT != 0
      )
    } finally {
      controller.destroy()
    }
  }

  @Test fun pairedCredentialsAreOnlyKeptWhileOptedIn() {
    val context = RuntimeEnvironment.getApplication()
    val prefs = PhoneConnectionStore.preferences(context)
    prefs.edit().clear().commit()
    PhoneConnectionStore.save(
      context,
      "[{\"environmentId\":\"env\",\"token\":\"secret\"}]",
      "t3dulli"
    )
    assertFalse(prefs.contains("connections"))

    prefs.edit().putBoolean("enabled", true).putString("connections", "encrypted").commit()
    PhoneConnectionService.setEnabled(context, false)
    assertFalse(prefs.contains("connections"))
  }
}

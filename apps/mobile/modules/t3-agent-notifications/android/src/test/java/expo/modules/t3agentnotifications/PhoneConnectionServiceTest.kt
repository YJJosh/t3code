package expo.modules.t3agentnotifications

import android.app.NotificationManager
import android.app.Service
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
}

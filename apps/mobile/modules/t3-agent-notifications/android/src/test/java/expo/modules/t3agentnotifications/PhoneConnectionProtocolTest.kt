package expo.modules.t3agentnotifications

import android.net.Uri
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26])
class PhoneConnectionProtocolTest {
  @Test fun upgradesDeclareThePairedClientsProtocolAndPreserveProxyPaths() {
    for (base in listOf("wss://server.test", "wss://server.test/t3/ws")) {
      val config = JSONObject().put("wsBaseUrl", base).put("protocolVersion", 2)
      val url = Uri.parse(phoneSocketUrl(config, "one+use/ticket"))
      assertEquals("2", url.getQueryParameter("orchestrationProtocol"))
      config.put("protocolVersion", 1)
      assertEquals("2", Uri.parse(phoneSocketUrl(config, "ticket")).getQueryParameter("orchestrationProtocol"))
      config.remove("protocolVersion")
      assertEquals("2", Uri.parse(phoneSocketUrl(config, "ticket")).getQueryParameter("orchestrationProtocol"))
      assertEquals("one+use/ticket", url.getQueryParameter("wsTicket"))
      assertEquals(if (base.endsWith("/t3/ws")) "/t3/ws" else "/ws", url.path)
    }
  }
}

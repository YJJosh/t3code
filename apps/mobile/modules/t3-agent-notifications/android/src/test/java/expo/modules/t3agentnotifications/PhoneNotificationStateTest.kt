package expo.modules.t3agentnotifications

import android.app.Application
import android.content.Context
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [26, 33, 36], manifest = Config.NONE)
class PhoneNotificationStateTest {
  private lateinit var context: Application
  private lateinit var state: PhoneNotificationState
  @Before fun setup() {
    context = RuntimeEnvironment.getApplication()
    PhoneConnectionStore.preferences(context).edit().clear().commit()
    state = PhoneNotificationState(PhoneConnectionStore.preferences(context))
  }
  private fun thread(request: String? = null, run: String? = null, status: String = "running") = JSONObject()
    .put("id", "thread").put("title", "A task").put("status", status)
    .put("archivedAt", JSONObject.NULL).put("deletedAt", JSONObject.NULL)
    .put("latestRunId", run ?: JSONObject.NULL)
    .put("latestRunCompletedAt", if (run != null) "2026-01-01T00:00:00Z" else JSONObject.NULL)
    .put("pendingRuntimeRequest", if (request == null) JSONObject.NULL else JSONObject().put("id", request).put("kind", "user_input"))

  @Test fun pendingRequestsNotifyOnceAcrossReconnectAndProcessRestartThenClearWhenAnswered() {
    val first = state.thread("env", thread("question"), 0)
    assertEquals("Your agent needs input", first.alerts.single().body)
    assertTrue(state.thread("env", thread("question"), 0).alerts.isEmpty())
    state = PhoneNotificationState(PhoneConnectionStore.preferences(context))
    assertTrue(state.thread("env", thread("question"), 0).alerts.isEmpty())
    assertEquals(listOf(first.alerts.single().id), state.thread("env", thread(), 0).clear)
    assertTrue(state.thread("env", thread(), 0).clear.isEmpty())
    assertEquals(1, state.thread("env", thread("next-question"), 0).alerts.size)
    assertEquals(1, state.thread("other-env", thread("question"), 0).alerts.size)
  }
  @Test fun completionOnlyNotifiesNewFinishedRunsAndNeverRunningTurnsOrOldHistory() {
    assertTrue(state.thread("env", thread(run = "one"), 0).alerts.isEmpty())
    assertTrue(state.thread("env", thread(run = "one", status = "completed"), Long.MAX_VALUE).alerts.isEmpty())
    assertEquals("Turn finished", state.thread("env", thread(run = "one", status = "completed"), 0).alerts.single().body)
    assertTrue(state.thread("env", thread(run = "one", status = "completed"), 0).alerts.isEmpty())
    assertEquals("Turn failed", state.thread("env", thread(run = "two", status = "failed"), 0).alerts.single().body)
    val subagent = { run: String -> thread(run = run, status = "completed")
      .put("lineage", JSONObject().put("relationshipToParent", "subagent")) }
    assertTrue(state.thread("env", subagent("three"), 0).alerts.isEmpty())
    assertEquals(1, state.thread("env", subagent("four").put("pendingRuntimeRequest",
      JSONObject().put("id", "approval").put("kind", "command_approval")), 0).alerts.size)
  }
  @Test fun removedAndArchivedRequestsClearEvenAfterAnOfflineReconnect() {
    val first = state.thread("env", thread("question"), 0).alerts.single()
    assertEquals(listOf(first.id), state.reconcile("env", emptySet()))
    val second = state.thread("env", thread("next"), 0).alerts.single()
    assertEquals(listOf(second.id), state.thread("env", thread("next").put("archivedAt", "2026-01-01"), 0).clear)
    assertTrue(state.thread("env", thread("hidden").put("deletedAt", "2026-01-01"), 0).alerts.isEmpty())
  }
  @Test fun reconciliationPrunesSeenHistoryEvenWithoutPendingRequests() {
    val prefs = PhoneConnectionStore.preferences(context)
    prefs.edit().putString("seen-request:env/gone", "request")
      .putString("seen-run:env/gone", "run").putString("seen-run:env/kept", "run")
      .putString("seen-run:other/thread", "run").commit()
    state.reconcile("env", setOf("kept"))
    assertFalse(prefs.contains("seen-request:env/gone"))
    assertFalse(prefs.contains("seen-run:env/gone"))
    assertTrue(prefs.contains("seen-run:env/kept"))
    assertTrue(prefs.contains("seen-run:other/thread"))
    PhoneConnectionStore.save(context, "[{\"environmentId\":\"other\"}]", "t3dulli")
    assertFalse(prefs.contains("seen-run:env/kept"))
    assertTrue(prefs.contains("seen-run:other/thread"))
  }

}

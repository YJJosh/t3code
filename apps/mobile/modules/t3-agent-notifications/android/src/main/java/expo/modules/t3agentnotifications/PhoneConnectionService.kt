package expo.modules.t3agentnotifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.random.Random

class PhoneConnectionBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action in listOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED) &&
      PhoneConnectionStore.preferences(context).getBoolean("enabled", false)) {
      PhoneConnectionService.start(context)
    }
  }
}

class PhoneConnectionService : Service() {
  companion object {
    private const val ID = 73002
    private const val CHANNEL = "dulli-connection"
    @Volatile var active = false
      private set
    fun start(context: Context) {
      ContextCompat.startForegroundService(context, Intent(context, PhoneConnectionService::class.java))
    }
    fun setEnabled(context: Context, enabled: Boolean) {
      val prefs = PhoneConnectionStore.preferences(context)
      val wasEnabled = prefs.getBoolean("enabled", false)
      prefs.edit().putBoolean("enabled", enabled).apply {
        if (enabled && !wasEnabled) putLong("since", System.currentTimeMillis())
      }.commit()
      if (enabled) {
        try { start(context) } catch (error: Exception) {
          prefs.edit().putBoolean("enabled", wasEnabled).commit()
          throw error
        }
      } else {
        context.stopService(Intent(context, PhoneConnectionService::class.java))
        prefs.edit().remove("connections").commit()
        AgentNotifications.clearPhoneAlerts(context)
      }
    }
  }

  private val handler = Handler(Looper.getMainLooper())
  private val client = OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS)
    .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
  private val connections = mutableListOf<Connection>()
  private var running = false
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (!PhoneConnectionStore.preferences(this).getBoolean("enabled", false)) {
      stopSelf()
      return START_NOT_STICKY
    }
    running = true
    active = true
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, "Dulli connection", NotificationManager.IMPORTANCE_LOW))
    }
    startForeground(ID, notification("Connecting to paired servers"))
    connections.forEach { it.close() }
    connections.clear()
    val configs = PhoneConnectionStore.load(this)
    for (index in 0 until configs.length()) connections.add(Connection(configs.getJSONObject(index)))
    connections.forEach { it.connect() }
    updateStatus()
    return START_STICKY
  }

  private fun notification(detail: String) = NotificationCompat.Builder(this, CHANNEL)
    .setSmallIcon(resources.getIdentifier("notification_icon", "drawable", packageName).takeIf { it != 0 }
      ?: android.R.drawable.ic_dialog_info)
    .setContentTitle("Dulli connected").setContentText(detail)
    .setOngoing(true).setSilent(true).setOnlyAlertOnce(true)
    .setPriority(NotificationCompat.PRIORITY_LOW)
    .setContentIntent(packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, ID, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }).build()

  private fun updateStatus() {
    if (!running) return
    val count = connections.count { it.connected }
    getSystemService(NotificationManager::class.java).notify(ID, notification(
      if (connections.isEmpty()) "Pair a server to receive notifications"
      else if (count == connections.size) "Listening to $count paired server(s)"
      else "Reconnecting · $count/${connections.size} servers online"
    ))
  }

  override fun onDestroy() {
    running = false
    active = false
    connections.forEach { it.close() }
    connections.clear()
    handler.removeCallbacksAndMessages(null)
    client.dispatcher.cancelAll()
    client.connectionPool.evictAll()
    client.dispatcher.executorService.shutdown()
    super.onDestroy()
  }

  private inner class Connection(private val config: JSONObject) {
    private val environment = config.getString("environmentId")
    private var socket: WebSocket? = null
    private var ticketCall: Call? = null
    private var closed = false
    private var attempt = 0
    private var generation = 0
    var connected = false
    private val state = PhoneNotificationState(PhoneConnectionStore.preferences(this@PhoneConnectionService))
    private val retry = Runnable { connect() }

    fun connect() {
      if (closed || !running) return
      val current = ++generation
      val base = config.getString("httpBaseUrl").trimEnd('/')
      val request = Request.Builder().url("$base/api/auth/websocket-ticket/rpc")
        .header("Authorization", "Bearer ${config.getString("token")}")
        .post(ByteArray(0).toRequestBody()).build()
      ticketCall = client.newCall(request).also { call ->
        call.enqueue(object : Callback {
          override fun onFailure(call: Call, e: IOException) { handler.post { failed(current) } }
          override fun onResponse(call: Call, response: Response) {
            val ticket = response.use {
              if (it.isSuccessful) runCatching { JSONObject(it.body!!.string()).getString("ticket") }.getOrNull() else null
            }
            handler.post {
              if (closed || current != generation) return@post
              if (ticket == null) { failed(current); return@post }
              val url = phoneSocketUrl(config, ticket)
              socket = client.newWebSocket(Request.Builder().url(url).build(), listener(current))
            }
          }
        })
      }
    }

    private fun listener(current: Int) = object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        handler.post {
          if (closed || current != generation) { webSocket.cancel(); return@post }
          connected = true
          attempt = 0
          updateStatus()
          webSocket.send(JSONObject().put("_tag", "Request").put("id", "phone-shell")
            .put("tag", "orchestration.subscribeShell").put("payload", JSONObject())
            .put("headers", JSONArray()).toString())
        }
      }
      override fun onMessage(webSocket: WebSocket, text: String) {
        handler.post {
          if (closed || current != generation) return@post
          runCatching {
            val frame = JSONObject(text)
            when (frame.optString("_tag")) {
              "Ping" -> webSocket.send("{\"_tag\":\"Pong\"}")
              "Chunk" -> {
                if (frame.optString("requestId") != "phone-shell") return@runCatching
                val values = frame.getJSONArray("values")
                for (i in 0 until values.length()) receive(values.getJSONObject(i))
                webSocket.send("{\"_tag\":\"Ack\",\"requestId\":\"phone-shell\"}")
              }
              "Exit", "Defect" -> failed(current)
            }
          }.onFailure { failed(current) }
        }
      }
      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        handler.post { failed(current) }
      }
      override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(code, reason)
      }
      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        handler.post { failed(current) }
      }
    }

    private fun receive(item: JSONObject) {
      val prefs = PhoneConnectionStore.preferences(this@PhoneConnectionService)
      fun show(thread: JSONObject) {
        val decision = state.thread(environment, thread, prefs.getLong("since", Long.MAX_VALUE))
        decision.clear.forEach { AgentNotifications.clearPhoneAlert(this@PhoneConnectionService, it) }
        decision.alerts.forEach {
          AgentNotifications.phoneAlert(this@PhoneConnectionService, prefs.getString("scheme", "t3dulli")!!,
            it.id, it.title, it.body, "/threads/$environment/${thread.getString("id")}")
        }
      }
      when (item.optString("kind")) {
        "snapshot" -> {
          val snapshot = item.getJSONObject("snapshot")
          val threads = snapshot.getJSONArray("threads")
          val ids = mutableSetOf<String>()
          for (i in 0 until threads.length()) {
            val thread = threads.getJSONObject(i)
            ids.add(thread.getString("id"))
            show(thread)
          }
          state.reconcile(environment, ids).forEach { AgentNotifications.clearPhoneAlert(this@PhoneConnectionService, it) }
        }
        "thread.updated" -> show(item.getJSONObject("thread"))
        "thread.removed" -> state.remove(environment, item.getString("threadId"))
          .forEach { AgentNotifications.clearPhoneAlert(this@PhoneConnectionService, it) }
      }
    }

    private fun failed(current: Int) {
      if (closed || current != generation) return
      generation++
      connected = false
      socket?.cancel()
      socket = null
      updateStatus()
      handler.removeCallbacks(retry)
      val delay = min(60_000L, 1_000L * (1L shl min(attempt++, 6)))
      handler.postDelayed(retry, delay + Random.nextLong(delay / 4 + 1))
    }

    fun close() {
      closed = true
      generation++
      handler.removeCallbacks(retry)
      ticketCall?.cancel()
      socket?.cancel()
    }
  }
}

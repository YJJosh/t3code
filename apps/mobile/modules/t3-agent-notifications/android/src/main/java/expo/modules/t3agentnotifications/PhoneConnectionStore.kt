package expo.modules.t3agentnotifications

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONArray
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal object PhoneConnectionStore {
  private const val ALIAS = "t3-phone-connections"
  fun preferences(
    context: Context
  ) = context.getSharedPreferences("t3-phone-connection", Context.MODE_PRIVATE)

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    return (store.getKey(ALIAS, null) as? SecretKey) ?: KeyGenerator.getInstance(
      KeyProperties.KEY_ALGORITHM_AES,
      "AndroidKeyStore"
    ).apply {
      init(
        KeyGenParameterSpec.Builder(
          ALIAS,
          KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
          .setBlockModes(
            KeyProperties.BLOCK_MODE_GCM
          ).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build()
      )
    }.generateKey()
  }

  @Synchronized
  fun save(context: Context, connections: String, scheme: String) {
    val prefs = preferences(context)
    val next = JSONArray(connections)
    val environments = (0 until next.length()).map {
      next.getJSONObject(it).getString("environmentId")
    }.toSet()
    PhoneNotificationState(prefs).retainEnvironments(environments)
    // The paired credentials are copied here only while the user has opted in.
    if (!prefs.getBoolean("enabled", false)) {
      prefs.edit().remove("connections").putString("scheme", scheme).commit()
      return
    }
    val previous = load(context)
    if (previous.toString() == next.toString() && prefs.getString("scheme", null) == scheme) {
      if (prefs.getBoolean("enabled", false) &&
        !PhoneConnectionService.active
      ) {
        PhoneConnectionService.start(context)
      }
      return
    }
    for (index in 0 until previous.length()) {
      val environment = previous.getJSONObject(index).getString("environmentId")
      if (environment !in environments) AgentNotifications.clearPhoneAlerts(context, environment)
    }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
    val encrypted = cipher.doFinal(connections.toByteArray(Charsets.UTF_8))
    prefs.edit().putString(
      "connections",
      Base64.encodeToString(cipher.iv + encrypted, Base64.NO_WRAP)
    )
      .putString("scheme", scheme).commit()
    if (prefs.getBoolean("enabled", false)) PhoneConnectionService.start(context)
  }

  fun load(context: Context): JSONArray = runCatching {
    val value = preferences(context).getString("connections", null) ?: return JSONArray()
    val bytes = Base64.decode(value, Base64.NO_WRAP)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
      init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
    }
    JSONArray(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
  }.getOrElse { JSONArray() }
}

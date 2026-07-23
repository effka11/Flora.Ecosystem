package expo.modules.florasecurepush

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class FloraSecurePushMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    when (message.data["type"]) {
      "secure_message_v1" -> handleSecureMessage(message.data)
      "app_update" -> Log.i(TAG, "app_update FCM received — ignored (button-only update)")
      else -> delegateToExpo(applicationContext) { it.onMessageReceived(message) }
    }
  }

  override fun onNewToken(token: String) {
    delegateToExpo(applicationContext) { it.onNewToken(token) }
  }

  override fun onDeletedMessages() {
    delegateToExpo(applicationContext) { it.onDeletedMessages() }
  }

  private fun handleSecureMessage(data: Map<String, String>) {
    val conversationUuid = data["conversationUuid"]?.trim()?.lowercase() ?: return
    val persistedMessageUuid = data["persistedMessageUuid"]?.trim()?.lowercase() ?: return
    val store = SecurePushKeyStore(applicationContext)
    if (store.isAppForeground() && store.activeConversation() == conversationUuid) return
    if (isDuplicate(persistedMessageUuid)) return

    var body = data["body"]?.trim().orEmpty().ifEmpty { "Новое сообщение" }
    val capability = store.capability()
    val privateKey = store.readPrivateKey()
    val envelope = data["encryptedPreview"]
    val owner = store.ownerUserUuid()
    if (
      store.previewsEnabled() &&
      capability != null &&
      privateKey != null &&
      envelope != null &&
      owner != null &&
      FscpPreviewNative.loaded
    ) {
      body = FscpPreviewNative.openPreview(
        envelope,
        owner,
        capability.installationUuid,
        capability.previewKeyId,
        privateKey,
      )?.trim().orEmpty().ifEmpty { body }
    }
    showNotification(
      conversationUuid = conversationUuid,
      senderUserUuid = data["senderUserUuid"].orEmpty(),
      title = data["title"]?.trim().orEmpty().ifEmpty { "Flora" },
      body = body,
      persistedMessageUuid = persistedMessageUuid,
    )
    remember(persistedMessageUuid)
  }

  private fun showNotification(
    conversationUuid: String,
    senderUserUuid: String,
    title: String,
    body: String,
    persistedMessageUuid: String,
  ) {
    if (
      Build.VERSION.SDK_INT >= 33 &&
      ActivityCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
        PackageManager.PERMISSION_GRANTED
    ) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      manager.createNotificationChannel(
        NotificationChannel(
          CHANNEL_MESSAGES,
          "Сообщения",
          NotificationManager.IMPORTANCE_HIGH,
        ),
      )
    }
    val scheme = if (packageName.endsWith(".dev")) "flora-dev" else "flora"
    val uri = Uri.parse(
      "$scheme://messages/$conversationUuid?senderUserUuid=${Uri.encode(senderUserUuid)}",
    )
    val launchIntent = Intent(Intent.ACTION_VIEW, uri).apply {
      setPackage(packageName)
      putExtra("type", "message")
      putExtra("conversationUuid", conversationUuid)
      putExtra("senderUserUuid", senderUserUuid)
      putExtra("persistedMessageUuid", persistedMessageUuid)
      flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    val pendingIntent = PendingIntent.getActivity(
      this,
      conversationUuid.hashCode(),
      launchIntent,
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )
    val icon = resources.getIdentifier("notification_icon", "drawable", packageName)
      .takeIf { it != 0 } ?: applicationInfo.icon
    val notification = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
      .setSmallIcon(icon)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setContentIntent(pendingIntent)
      .setAutoCancel(true)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setGroup(conversationUuid)
      .build()
    manager.notify(conversationUuid, conversationUuid.hashCode(), notification)
  }

  private fun isDuplicate(messageUuid: String): Boolean =
    getSharedPreferences(DEDUPE_PREFS, Context.MODE_PRIVATE)
      .getStringSet(DEDUPE_KEY, emptySet())
      ?.contains(messageUuid) == true

  private fun remember(messageUuid: String) {
    val prefs = getSharedPreferences(DEDUPE_PREFS, Context.MODE_PRIVATE)
    val entries = prefs.getStringSet(DEDUPE_KEY, emptySet()).orEmpty().toMutableList()
    entries.remove(messageUuid)
    entries.add(messageUuid)
    prefs.edit().putStringSet(DEDUPE_KEY, entries.takeLast(128).toSet()).apply()
  }

  private fun delegateToExpo(context: Context, block: (FirebaseMessagingService) -> Unit) {
    try {
      val clazz = Class.forName(EXPO_FMS)
      val instance = clazz.getDeclaredConstructor().newInstance() as FirebaseMessagingService
      var attached = false
      var current: Class<*>? = instance.javaClass
      while (current != null && !attached) {
        try {
          val method = current.getDeclaredMethod("attachBaseContext", Context::class.java)
          method.isAccessible = true
          method.invoke(instance, context)
          attached = true
        } catch (_: NoSuchMethodException) {
          current = current.superclass
        }
      }
      if (attached) block(instance)
    } catch (error: Exception) {
      Log.e(TAG, "Expo FMS delegation failed", error)
    }
  }

  private companion object {
    const val TAG = "FloraSecurePush"
    const val CHANNEL_MESSAGES = "messages"
    const val DEDUPE_PREFS = "flora_secure_push_dedupe"
    const val DEDUPE_KEY = "message_ids"
    const val EXPO_FMS = "expo.modules.notifications.service.ExpoFirebaseMessagingService"
  }
}

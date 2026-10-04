package expo.modules.florasecurepush

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.Rect
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import kotlin.math.min

class FloraSecurePushMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    when (message.data["type"]) {
      "secure_message_v1" -> handleSecureMessage(message.data)
      // Defense-in-depth if a server still emits legacy `type=message` as data-only.
      "message" -> handleLegacyMessage(message.data)
      "app_update" -> handleAppUpdate(message.data)
      else -> delegateToExpo(applicationContext) { it.onMessageReceived(message) }
    }
  }

  /**
   * Soft-call flora-apk-updater UpdateCoordinator (absent on Play builds).
   * Downloads only when native auto-update preference is ON.
   */
  private fun handleAppUpdate(data: Map<String, String>) {
    Log.i(TAG, "app_update FCM received")
    try {
      val clazz = Class.forName(UPDATE_COORDINATOR)
      val instance = clazz.getField("INSTANCE").get(null)
      val parse = clazz.getMethod("parseManifestFromData", Map::class.java)
      val manifest = parse.invoke(instance, data) ?: run {
        Log.w(TAG, "app_update missing/invalid update fields — ignored")
        return
      }
      val manifestClass = Class.forName(UPDATE_MANIFEST)
      val start =
        clazz.getMethod(
          "startAuto",
          Context::class.java,
          manifestClass,
          Boolean::class.javaPrimitiveType,
        )
      start.invoke(instance, applicationContext, manifest, false)
    } catch (_: ClassNotFoundException) {
      Log.i(TAG, "app_update: FloraApkUpdater not linked — inbox only")
    } catch (_: NoClassDefFoundError) {
      Log.i(TAG, "app_update: FloraApkUpdater not linked — inbox only")
    } catch (e: Exception) {
      Log.w(TAG, "app_update startAuto failed", e)
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
      avatarUrl = data["senderAvatarUrl"],
    )
    remember(persistedMessageUuid)
  }

  private fun handleLegacyMessage(data: Map<String, String>) {
    val conversationUuid = data["conversationUuid"]?.trim()?.lowercase() ?: return
    val store = SecurePushKeyStore(applicationContext)
    if (store.isAppForeground() && store.activeConversation() == conversationUuid) return
    val dedupeId = data["persistedMessageUuid"]?.trim()?.lowercase()
      ?: "${conversationUuid}:${data["title"].orEmpty()}:${data["body"].orEmpty()}"
    if (isDuplicate(dedupeId)) return
    showNotification(
      conversationUuid = conversationUuid,
      senderUserUuid = data["senderUserUuid"].orEmpty(),
      title = data["title"]?.trim().orEmpty().ifEmpty { "Flora" },
      body = data["body"]?.trim().orEmpty().ifEmpty { "Новое сообщение" },
      persistedMessageUuid = dedupeId,
      avatarUrl = data["senderAvatarUrl"],
    )
    remember(dedupeId)
  }

  private fun showNotification(
    conversationUuid: String,
    senderUserUuid: String,
    title: String,
    body: String,
    persistedMessageUuid: String,
    avatarUrl: String?,
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
    val avatar = toCircle(
      loadAvatar(avatarUrl) ?: drawDefaultAvatar(title),
    )
    val senderBuilder = Person.Builder()
      .setName(title)
      .setIcon(IconCompat.createWithBitmap(avatar))
      .setImportant(true)
    if (senderUserUuid.isNotBlank()) senderBuilder.setKey(senderUserUuid)
    val sender = senderBuilder.build()
    val localUser = Person.Builder().setName("Вы").setKey("flora-local-user").build()
    publishConversationShortcut(conversationUuid, title, avatar, sender, launchIntent)
    Log.i(
      TAG,
      "show message notification conversation=$conversationUuid hasAvatarUrl=${!avatarUrl.isNullOrBlank()} shortcut=$conversationUuid",
    )
    val notification = NotificationCompat.Builder(this, CHANNEL_MESSAGES)
      .setSmallIcon(icon)
      .setContentTitle(title)
      .setContentText(body)
      .setLargeIcon(avatar)
      .setStyle(
        NotificationCompat.MessagingStyle(localUser)
          .setGroupConversation(false)
          .addMessage(body, System.currentTimeMillis(), sender),
      )
      .setShortcutId(conversationUuid)
      .setContentIntent(pendingIntent)
      .setAutoCancel(true)
      .setCategory(NotificationCompat.CATEGORY_MESSAGE)
      .setGroup(conversationUuid)
      .build()
    manager.notify(conversationUuid, conversationUuid.hashCode(), notification)
  }

  private fun publishConversationShortcut(
    conversationUuid: String,
    title: String,
    avatar: Bitmap,
    sender: Person,
    launchIntent: Intent,
  ) {
    try {
      val label = title.trim().ifEmpty { "Flora" }.take(40)
      val shortcut = ShortcutInfoCompat.Builder(this, conversationUuid)
        .setShortLabel(label)
        .setLongLabel(label)
        .setIcon(IconCompat.createWithBitmap(avatar))
        .setIntent(launchIntent)
        .setLongLived(true)
        .setPerson(sender)
        .setCategories(setOf("android.shortcut.conversation"))
        .build()
      ShortcutManagerCompat.pushDynamicShortcut(this, shortcut)
    } catch (error: Exception) {
      Log.w(TAG, "Conversation shortcut publish failed", error)
    }
  }

  private fun loadAvatar(rawUrl: String?): Bitmap? {
    val avatarUrl = rawUrl?.trim()?.takeIf(::isTrustedAvatarUrl) ?: return null
    var connection: HttpURLConnection? = null
    return try {
      connection = URL(avatarUrl).openConnection() as? HttpURLConnection ?: return null
      connection.connectTimeout = AVATAR_CONNECT_TIMEOUT_MS
      connection.readTimeout = AVATAR_READ_TIMEOUT_MS
      connection.instanceFollowRedirects = false
      connection.setRequestProperty("Accept", "image/png,image/jpeg,image/webp")
      connection.connect()
      if (connection.responseCode !in 200..299) return null
      val contentLength = connection.contentLengthLong
      if (contentLength > MAX_AVATAR_BYTES) return null
      val bytes = connection.inputStream.use(::readBoundedAvatar) ?: return null
      decodeAvatar(bytes)
    } catch (error: Exception) {
      Log.w(TAG, "Sender avatar download failed", error)
      null
    } finally {
      connection?.disconnect()
    }
  }

  /** Flora default avatar (forest + initials) when sender has no uploaded photo. */
  private fun drawDefaultAvatar(title: String): Bitmap {
    val size = AVATAR_MAX_DIMENSION
    val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    paint.color = Color.parseColor(DEFAULT_AVATAR_BG)
    canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
    paint.color = Color.parseColor(DEFAULT_AVATAR_FG)
    paint.textAlign = Paint.Align.CENTER
    paint.typeface = Typeface.create(Typeface.DEFAULT, Typeface.NORMAL)
    paint.textSize = size * 0.36f
    val initials = profileInitials(title)
    val textY = size / 2f - (paint.descent() + paint.ascent()) / 2f
    canvas.drawText(initials, size / 2f, textY, paint)
    return bitmap
  }

  private fun profileInitials(displayName: String): String {
    val trimmed = displayName.trim().removePrefix("@")
    if (trimmed.length >= 2) return trimmed.take(2).uppercase()
    if (trimmed.length == 1) return "${trimmed.uppercase()}?"
    return "?"
  }

  private fun toCircle(source: Bitmap): Bitmap {
    val size = min(source.width, source.height)
    val output = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(output)
    val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    val rect = Rect(0, 0, size, size)
    canvas.drawCircle(size / 2f, size / 2f, size / 2f, paint)
    paint.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
    val left = (source.width - size) / 2
    val top = (source.height - size) / 2
    canvas.drawBitmap(source, Rect(left, top, left + size, top + size), rect, paint)
    return output
  }

  private fun isTrustedAvatarUrl(rawUrl: String): Boolean {
    val uri = Uri.parse(rawUrl)
    val host = uri.host?.lowercase() ?: return false
    return uri.scheme == "https" &&
      uri.userInfo == null &&
      (uri.port == -1 || uri.port == 443) &&
      (host == "flora-s.net" || host.endsWith(".flora-s.net"))
  }

  private fun readBoundedAvatar(input: java.io.InputStream): ByteArray? {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(8 * 1024)
    var total = 0
    while (true) {
      val count = input.read(buffer)
      if (count < 0) break
      total += count
      if (total > MAX_AVATAR_BYTES) return null
      output.write(buffer, 0, count)
    }
    return output.toByteArray()
  }

  private fun decodeAvatar(bytes: ByteArray): Bitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sampleSize = 1
    while (
      bounds.outWidth / sampleSize > AVATAR_MAX_DIMENSION ||
      bounds.outHeight / sampleSize > AVATAR_MAX_DIMENSION
    ) {
      sampleSize *= 2
    }
    val options = BitmapFactory.Options().apply { inSampleSize = sampleSize }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
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
    const val UPDATE_COORDINATOR = "expo.modules.floraapkupdater.UpdateCoordinator"
    const val UPDATE_MANIFEST = "expo.modules.floraapkupdater.UpdateManifest"
    const val AVATAR_CONNECT_TIMEOUT_MS = 2_000
    const val AVATAR_READ_TIMEOUT_MS = 2_500
    const val AVATAR_MAX_DIMENSION = 256
    const val MAX_AVATAR_BYTES = 2L * 1024 * 1024
    const val DEFAULT_AVATAR_BG = "#2c3527"
    const val DEFAULT_AVATAR_FG = "#a4d18a"
  }
}

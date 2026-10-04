package expo.modules.floraapkupdater

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

object UpdateTrayNotifier {
  private const val CHANNEL_ID = "notifications"
  private const val CHANNEL_UPDATE_ID = "app_updates"
  private const val NOTIF_ID_UPDATE = 0x710A0001
  private const val NOTIF_ID_READY = 0x710A0002
  private const val NOTIF_ID_CONFIRM = 0x710A0003
  private const val NOTIF_ID_FAILED = 0x710A0004

  private fun smallIcon(context: Context): Int {
    val id = context.resources.getIdentifier("notification_icon", "drawable", context.packageName)
    return if (id != 0) id else context.applicationInfo.icon
  }

  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (nm.getNotificationChannel(CHANNEL_ID) == null) {
      nm.createNotificationChannel(
        NotificationChannel(
          CHANNEL_ID,
          "Уведомления",
          NotificationManager.IMPORTANCE_DEFAULT,
        ),
      )
    }
    if (nm.getNotificationChannel(CHANNEL_UPDATE_ID) == null) {
      nm.createNotificationChannel(
        NotificationChannel(
          CHANNEL_UPDATE_ID,
          "Обновления приложения",
          NotificationManager.IMPORTANCE_HIGH,
        ).apply {
          description = "Установка обновлений Flora"
          setShowBadge(true)
        },
      )
    }
  }

  fun showUpdateAvailable(context: Context, title: String, body: String) {
    ensureChannel(context)
    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(smallIcon(context))
      .setContentTitle(title.ifBlank { "Flora" })
      .setContentText(body.ifBlank { "Доступно обновление" })
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)
      .setAutoCancel(true)
      .build()
    try {
      NotificationManagerCompat.from(context).notify(NOTIF_ID_UPDATE, notification)
    } catch (_: SecurityException) {
      // POST_NOTIFICATIONS denied — silent path still continues.
    }
  }

  fun showDownloadFailed(context: Context) {
    ensureChannel(context)
    val notification = NotificationCompat.Builder(context, CHANNEL_UPDATE_ID)
      .setSmallIcon(smallIcon(context))
      .setContentTitle("Flora")
      .setContentText("Не удалось скачать обновление")
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_ERROR)
      .setAutoCancel(false)
      .setOngoing(false)
      .build()
    try {
      NotificationManagerCompat.from(context).notify(NOTIF_ID_FAILED, notification)
    } catch (_: SecurityException) {
    }
  }

  fun showReady(context: Context, version: String) {
    ensureChannel(context)
    val notification = NotificationCompat.Builder(context, CHANNEL_UPDATE_ID)
      .setSmallIcon(smallIcon(context))
      .setContentTitle("Flora")
      .setContentText("Обновление $version готово к установке")
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setAutoCancel(true)
      .build()
    try {
      NotificationManagerCompat.from(context).notify(NOTIF_ID_READY, notification)
    } catch (_: SecurityException) {
    }
  }

  /**
   * OEM often rejects USER_ACTION_NOT_REQUIRED. Starting the confirm Activity from a
   * background WorkManager job is blocked on Android 10+ — surface a tappable notification
   * instead (user tap grants background-activity start).
   */
  fun showInstallConfirm(context: Context, confirmIntent: Intent, version: String) {
    ensureChannel(context)
    confirmIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        PendingIntent.FLAG_MUTABLE
      } else {
        0
      }
    val contentPi = PendingIntent.getActivity(context, NOTIF_ID_CONFIRM, confirmIntent, flags)
    val notification = NotificationCompat.Builder(context, CHANNEL_UPDATE_ID)
      .setSmallIcon(smallIcon(context))
      .setContentTitle("Установить обновление Flora")
      .setContentText("Версия $version готова — нажмите, чтобы установить")
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_STATUS)
      .setAutoCancel(true)
      .setContentIntent(contentPi)
      .setOngoing(false)
      .build()
    try {
      NotificationManagerCompat.from(context).notify(NOTIF_ID_CONFIRM, notification)
    } catch (_: SecurityException) {
      // Fall back: try starting confirm UI if we somehow have foreground rights.
      try {
        context.startActivity(confirmIntent)
      } catch (_: Exception) {
      }
    }
  }
}

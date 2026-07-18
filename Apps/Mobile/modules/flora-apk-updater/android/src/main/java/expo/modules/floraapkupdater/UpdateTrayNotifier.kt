package expo.modules.floraapkupdater

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

object UpdateTrayNotifier {
  private const val CHANNEL_ID = "notifications"
  private const val NOTIF_ID_UPDATE = 0xF10A_0001
  private const val NOTIF_ID_READY = 0xF10A_0002

  fun ensureChannel(context: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (nm.getNotificationChannel(CHANNEL_ID) != null) return
    nm.createNotificationChannel(
      NotificationChannel(
        CHANNEL_ID,
        "Уведомления",
        NotificationManager.IMPORTANCE_DEFAULT,
      ),
    )
  }

  fun showUpdateAvailable(context: Context, title: String, body: String) {
    ensureChannel(context)
    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(context.applicationInfo.icon)
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

  fun showReady(context: Context, version: String) {
    ensureChannel(context)
    val notification = NotificationCompat.Builder(context, CHANNEL_ID)
      .setSmallIcon(context.applicationInfo.icon)
      .setContentTitle("Flora")
      .setContentText("Обновление $version готово к установке")
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)
      .setAutoCancel(true)
      .build()
    try {
      NotificationManagerCompat.from(context).notify(NOTIF_ID_READY, notification)
    } catch (_: SecurityException) {
    }
  }
}

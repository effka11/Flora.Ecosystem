package expo.modules.floraapkupdater

import android.content.Context
import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Receives FCM MESSAGING_EVENT (replaces Expo's service via config plugin).
 * Handles `type=app_update` natively; delegates everything else to ExpoFirebaseMessagingService.
 */
class FloraAppUpdateMessagingService : FirebaseMessagingService() {
  override fun onMessageReceived(message: RemoteMessage) {
    val data = message.data
    if (data["type"] == "app_update") {
      // Data-only wake: download/install silently. No system tray — inbox covers UX.
      Log.i(TAG, "app_update FCM received")
      val manifest = UpdateCoordinator.parseManifestFromData(data)
      if (manifest != null) {
        UpdateCoordinator.startAuto(applicationContext, manifest, showTray = false)
      } else {
        Log.w(TAG, "app_update missing/invalid update fields — ignored")
      }
      return
    }
    delegateToExpo(applicationContext) { it.onMessageReceived(message) }
  }

  override fun onNewToken(token: String) {
    delegateToExpo(applicationContext) { it.onNewToken(token) }
  }

  override fun onDeletedMessages() {
    delegateToExpo(applicationContext) { it.onDeletedMessages() }
  }

  private fun delegateToExpo(context: Context, block: (FirebaseMessagingService) -> Unit) {
    try {
      val clazz = Class.forName(EXPO_FMS)
      val instance = clazz.getDeclaredConstructor().newInstance() as FirebaseMessagingService
      // ContextWrapper.attachBaseContext
      var attached = false
      var c: Class<*>? = instance.javaClass
      while (c != null && !attached) {
        try {
          val m = c.getDeclaredMethod("attachBaseContext", Context::class.java)
          m.isAccessible = true
          m.invoke(instance, context)
          attached = true
        } catch (_: NoSuchMethodException) {
          c = c.superclass
        }
      }
      if (!attached) {
        Log.w(TAG, "Could not attachBaseContext to Expo FMS")
        return
      }
      block(instance)
    } catch (e: Exception) {
      Log.e(TAG, "Expo FMS delegation failed", e)
    }
  }

  companion object {
    private const val TAG = "FloraAppUpdateFCM"
    private const val EXPO_FMS =
      "expo.modules.notifications.service.ExpoFirebaseMessagingService"
  }
}

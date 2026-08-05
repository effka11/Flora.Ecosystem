package expo.modules.floraapkupdater

import android.net.Uri

/** Only Flora Social APK channel URLs (social.flora-s.net/apk). */
object UpdateUrlAllowlist {
  private const val HOST = "social.flora-s.net"
  private val APK_PATH =
    Regex("^/apk/flora\\.social-v[0-9A-Za-z][0-9A-Za-z._+-]{0,127}-android\\.apk$")
  private const val LATEST_JSON = "/apk/flora.social-android-update.json"

  fun isAllowed(url: String): Boolean {
    return try {
      val uri = Uri.parse(url.trim())
      if (uri.scheme != "https") return false
      if (!HOST.equals(uri.host, ignoreCase = true)) return false
      if (!uri.userInfo.isNullOrEmpty()) return false
      if (!uri.query.isNullOrEmpty() || !uri.fragment.isNullOrEmpty()) return false
      val path = uri.path ?: return false
      path == LATEST_JSON || APK_PATH.matches(path)
    } catch (_: Exception) {
      false
    }
  }
}

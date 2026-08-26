package expo.modules.floraapkupdater

import android.net.Uri

/** Only Flora APK channel URLs (social.flora-s.net/apk). Keep in sync with Apps/Mobile/lib/apkUpdate/manifestSecurity.ts. */
object UpdateUrlAllowlist {
  private const val HOST = "social.flora-s.net"
  private val APK_PATHS =
    listOf(
      Regex(
        "^/apk/flora-v[0-9A-Za-z][0-9A-Za-z._+-]{0,127}\\.apk$",
        RegexOption.IGNORE_CASE,
      ),
      // Legacy sideload name; optional -{hex} after -android busts CDN.
      Regex(
        "^/apk/flora\\.social-v[0-9A-Za-z][0-9A-Za-z._+-]{0,127}-android(?:-[a-f0-9]{6,16})?\\.apk$",
        RegexOption.IGNORE_CASE,
      ),
    )
  private const val LATEST_JSON = "/apk/flora.social-android-update.json"

  fun isAllowed(url: String): Boolean {
    return try {
      val uri = Uri.parse(url.trim())
      if (uri.scheme != "https") return false
      if (!HOST.equals(uri.host, ignoreCase = true)) return false
      if (!uri.userInfo.isNullOrEmpty()) return false
      if (!uri.query.isNullOrEmpty() || !uri.fragment.isNullOrEmpty()) return false
      val path = uri.path ?: return false
      path.equals(LATEST_JSON, ignoreCase = true) || APK_PATHS.any { it.matches(path) }
    } catch (_: Exception) {
      false
    }
  }
}

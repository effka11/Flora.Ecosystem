package expo.modules.floraapkupdater

import android.net.Uri

object UpdateUrlAllowlist {
  private const val HOST = "github.com"
  private const val PATH_PREFIX = "/effka11/Flora.Ecosystem/releases/download/social/v"

  fun isAllowed(url: String): Boolean {
    return try {
      val uri = Uri.parse(url.trim())
      if (uri.scheme != "https") return false
      if (!HOST.equals(uri.host, ignoreCase = true)) return false
      val path = uri.path ?: return false
      path.startsWith(PATH_PREFIX) &&
        (path.endsWith(".apk", ignoreCase = true) ||
          path.endsWith("flora.social-android-update.json", ignoreCase = true))
    } catch (_: Exception) {
      false
    }
  }
}

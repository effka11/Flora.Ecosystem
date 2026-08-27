package expo.modules.floraapkupdater

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.util.Log
import java.io.File

private const val ADOPT_TAG = "FloraApkUpdate"

/** Channel JSON uses `FloraSocial-Android/...`; DownloadManager default UA is often blocked. */
fun applyFloraDownloadHeaders(request: DownloadManager.Request): DownloadManager.Request {
  request.addRequestHeader("User-Agent", "FloraSocial-Android")
  request.addRequestHeader("Accept", "*/*")
  return request
}

/**
 * If [dest] is empty, copy DownloadManager's staged file from [localUri].
 * `content://` → [android.content.ContentResolver]; `file://` → [File].
 * Never treats `content://` as a filesystem path (`removePrefix("file://")` is a no-op on
 * content URIs and yields a missing File).
 */
fun adoptDownloadManagerFile(context: Context, dest: File, localUri: String?): File? {
  if (dest.exists() && dest.length() > 0L) return dest
  if (localUri.isNullOrBlank()) return null

  val uri = Uri.parse(localUri.trim())
  val scheme = uri.scheme?.lowercase() ?: return null

  dest.parentFile?.mkdirs()
  try {
    when (scheme) {
      "content" -> {
        val input = context.contentResolver.openInputStream(uri)
        if (input == null) {
          Log.w(ADOPT_TAG, "adopt: ContentResolver openInputStream null for $localUri")
          return null
        }
        input.use { src ->
          dest.outputStream().use { out -> src.copyTo(out) }
        }
      }
      "file" -> {
        val path = uri.path
        if (path.isNullOrBlank()) return null
        val src = File(path)
        if (!src.exists() || src.length() <= 0L) return null
        if (src.absolutePath != dest.absolutePath) {
          src.copyTo(dest, overwrite = true)
        }
      }
      else -> {
        Log.w(ADOPT_TAG, "adopt: unsupported scheme=$scheme uri=$localUri")
        return null
      }
    }
  } catch (e: Exception) {
    Log.w(ADOPT_TAG, "adopt failed uri=$localUri", e)
    return null
  }

  return if (dest.exists() && dest.length() > 0L) dest else null
}

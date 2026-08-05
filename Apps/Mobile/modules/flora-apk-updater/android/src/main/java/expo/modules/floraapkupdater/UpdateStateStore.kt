package expo.modules.floraapkupdater

import android.content.Context

enum class UpdatePhase {
  IDLE,
  DOWNLOADING,
  READY,
  INSTALL_SCHEDULED,
  INSTALLING,
  FAILED,
}

data class UpdateManifest(
  val version: String,
  val versionCode: Int,
  val apkUrl: String,
  val sha256: String,
  val sizeBytes: Long?,
  val notificationUuid: String?,
  val text: String?,
)

/** Persisted sideload update state (SharedPreferences + pending.apk on disk). */
class UpdateStateStore(context: Context) {
  private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun getPhase(): UpdatePhase {
    return try {
      UpdatePhase.valueOf(prefs.getString(KEY_PHASE, UpdatePhase.IDLE.name) ?: UpdatePhase.IDLE.name)
    } catch (_: Exception) {
      UpdatePhase.IDLE
    }
  }

  fun setPhase(phase: UpdatePhase) {
    prefs.edit().putString(KEY_PHASE, phase.name).apply()
  }

  fun getManifest(): UpdateManifest? {
    val versionCode = prefs.getInt(KEY_VERSION_CODE, -1)
    val version = prefs.getString(KEY_VERSION, null) ?: return null
    val apkUrl = prefs.getString(KEY_APK_URL, null) ?: return null
    val sha256 = prefs.getString(KEY_SHA256, null) ?: return null
    if (versionCode < 1 || version.isBlank() || apkUrl.isBlank() || sha256.isBlank()) return null
    val size = prefs.getLong(KEY_SIZE, -1L)
    return UpdateManifest(
      version = version,
      versionCode = versionCode,
      apkUrl = apkUrl,
      sha256 = sha256,
      sizeBytes = if (size > 0) size else null,
      notificationUuid = prefs.getString(KEY_NOTIF_UUID, null),
      text = prefs.getString(KEY_TEXT, null),
    )
  }

  fun saveManifest(manifest: UpdateManifest) {
    prefs.edit()
      .putString(KEY_VERSION, manifest.version)
      .putInt(KEY_VERSION_CODE, manifest.versionCode)
      .putString(KEY_APK_URL, manifest.apkUrl)
      .putString(KEY_SHA256, manifest.sha256.lowercase())
      .putLong(KEY_SIZE, manifest.sizeBytes ?: -1L)
      .putString(KEY_NOTIF_UUID, manifest.notificationUuid)
      .putString(KEY_TEXT, manifest.text)
      .apply()
  }

  fun getDownloadId(): Long = prefs.getLong(KEY_DOWNLOAD_ID, -1L)

  fun setDownloadId(id: Long) {
    prefs.edit().putLong(KEY_DOWNLOAD_ID, id).apply()
  }

  fun getLastError(): String? = prefs.getString(KEY_ERROR, null)

  fun setLastError(message: String?) {
    prefs.edit().putString(KEY_ERROR, message).apply()
  }

  fun clearError() {
    prefs.edit().remove(KEY_ERROR).apply()
  }

  fun resetToIdle() {
    prefs.edit()
      .putString(KEY_PHASE, UpdatePhase.IDLE.name)
      .remove(KEY_ERROR)
      .putLong(KEY_DOWNLOAD_ID, -1L)
      .apply()
  }

  fun isAutoUpdateEnabled(): Boolean = prefs.getBoolean(KEY_AUTO_UPDATE, false)

  fun setAutoUpdateEnabled(enabled: Boolean) {
    prefs.edit().putBoolean(KEY_AUTO_UPDATE, enabled).apply()
  }

  fun toJsMap(): Map<String, Any?> {
    val m = getManifest()
    return mapOf(
      "phase" to getPhase().name,
      "version" to m?.version,
      "versionCode" to m?.versionCode,
      "apkUrl" to m?.apkUrl,
      "sha256" to m?.sha256,
      "sizeBytes" to m?.sizeBytes,
      "lastError" to getLastError(),
      "downloadId" to getDownloadId(),
      "autoUpdateEnabled" to isAutoUpdateEnabled(),
    )
  }

  companion object {
    private const val PREFS = "flora_apk_update"
    private const val KEY_PHASE = "phase"
    private const val KEY_VERSION = "version"
    private const val KEY_VERSION_CODE = "versionCode"
    private const val KEY_APK_URL = "apkUrl"
    private const val KEY_SHA256 = "sha256"
    private const val KEY_SIZE = "sizeBytes"
    private const val KEY_NOTIF_UUID = "notificationUuid"
    private const val KEY_TEXT = "text"
    private const val KEY_DOWNLOAD_ID = "downloadId"
    private const val KEY_ERROR = "lastError"
    private const val KEY_AUTO_UPDATE = "autoUpdateEnabled"
  }
}

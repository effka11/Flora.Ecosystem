package expo.modules.floraapkupdater

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

class FloraApkUpdaterModule : Module() {
  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private val downloadExecutor = Executors.newSingleThreadExecutor()
  private val downloadCancel = AtomicBoolean(false)
  private val activeDownloadId = AtomicLong(-1)
  private val mainHandler = Handler(Looper.getMainLooper())

  private fun resolveOnMain(promise: Promise, value: Any) {
    mainHandler.post { promise.resolve(value) }
  }

  private fun rejectOnMain(promise: Promise, code: String, message: String?, throwable: Throwable? = null) {
    mainHandler.post { promise.reject(code, message, throwable) }
  }

  private fun emitProgress(written: Long, total: Long) {
    mainHandler.post {
      sendEvent(
        "onDownloadProgress",
        mapOf(
          "written" to written,
          "total" to total,
        ),
      )
    }
  }

  override fun definition() = ModuleDefinition {
    Name("FloraApkUpdater")

    Events("onDownloadProgress")

    OnCreate {
      activeModule.set(this@FloraApkUpdaterModule)
    }

    OnDestroy {
      downloadCancel.set(true)
      cancelActiveSystemDownload()
      activeModule.compareAndSet(this@FloraApkUpdaterModule, null)
    }

    Function("isAvailable") {
      true
    }

    Function("canRequestPackageInstalls") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
        return@Function true
      }
      context.packageManager.canRequestPackageInstalls()
    }

    Function("sdkInt") {
      Build.VERSION.SDK_INT
    }

    Function("getUpdateDir") {
      updateDir().absolutePath
    }

    Function("getUpdateState") {
      UpdateCoordinator.getState(context)
    }

    Function("isAutoUpdateEnabled") {
      UpdateStateStore(context).isAutoUpdateEnabled()
    }

    Function("setAutoUpdateEnabled") { enabled: Boolean ->
      UpdateStateStore(context).setAutoUpdateEnabled(enabled)
      true
    }

    AsyncFunction("startAutoUpdate") { manifest: Map<String, Any?>, promise: Promise ->
      try {
        val parsed = UpdateCoordinator.parseManifestFromJs(manifest)
        if (parsed == null) {
          promise.reject("E_MANIFEST", "Invalid update manifest", null)
          return@AsyncFunction
        }
        UpdateCoordinator.startAuto(context, parsed, showTray = false)
        promise.resolve(UpdateCoordinator.getState(context))
      } catch (e: Exception) {
        promise.reject("E_START", e.message, e)
      }
    }

    Function("cancelUpdate") {
      UpdateCoordinator.cancel(context)
      downloadCancel.set(true)
      cancelActiveSystemDownload()
      true
    }

    Function("cancelDownload") {
      downloadCancel.set(true)
      cancelActiveSystemDownload()
      true
    }

    AsyncFunction("requestInstallPermission") { promise: Promise ->
      try {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
          promise.resolve(true)
          return@AsyncFunction
        }
        if (context.packageManager.canRequestPackageInstalls()) {
          promise.resolve(true)
          return@AsyncFunction
        }
        val intent = Intent(
          Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:${context.packageName}"),
        )
        val activity = appContext.currentActivity
        if (activity != null) {
          activity.startActivity(intent)
        } else {
          intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          context.startActivity(intent)
        }
        promise.resolve(false)
      } catch (e: Exception) {
        promise.reject("E_INSTALL_PERMISSION", e.message, e)
      }
    }

    AsyncFunction("sha256File") { filePath: String, promise: Promise ->
      try {
        val file = resolveApkFile(filePath)
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
          val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
          while (true) {
            val read = input.read(buffer)
            if (read <= 0) break
            digest.update(buffer, 0, read)
          }
        }
        promise.resolve(digest.digest().joinToString("") { "%02x".format(it) })
      } catch (e: Exception) {
        promise.reject("E_SHA256", e.message, e)
      }
    }

    AsyncFunction("downloadFile") { url: String, filePath: String, promise: Promise ->
      downloadCancel.set(false)
      downloadExecutor.execute {
        var downloadId = -1L
        try {
          val dest = resolveApkFile(filePath)
          dest.parentFile?.mkdirs()
          if (dest.exists()) dest.delete()

          val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
          val relativePath = "flora-update/${dest.name}"
          val request = DownloadManager.Request(Uri.parse(url))
            .setTitle("Flora")
            .setDescription("Загрузка обновления")
            .setMimeType("application/vnd.android.package-archive")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
            .setAllowedOverMetered(true)
            .setAllowedOverRoaming(true)
            .setDestinationInExternalFilesDir(context, null, relativePath)

          downloadId = dm.enqueue(request)
          activeDownloadId.set(downloadId)

          // Canonical path used by setDestinationInExternalFilesDir
          val expectedFile = File(context.getExternalFilesDir(null), relativePath)

          var lastEmit = 0L
          while (true) {
            if (downloadCancel.get()) {
              dm.remove(downloadId)
              activeDownloadId.set(-1)
              rejectOnMain(promise, "E_CANCELLED", "cancelled")
              return@execute
            }

            val query = DownloadManager.Query().setFilterById(downloadId)
            dm.query(query).use { cursor ->
              if (cursor == null || !cursor.moveToFirst()) {
                Thread.sleep(400)
                return@use
              }

              val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
              val written = cursor.getLong(
                cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR),
              )
              val total = cursor.getLong(
                cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES),
              )
              val reasonIdx = cursor.getColumnIndex(DownloadManager.COLUMN_REASON)
              val reason = if (reasonIdx >= 0) cursor.getInt(reasonIdx) else 0

              // Emit often so JS progress bar moves (DownloadManager may not
              // expose a partial file for polling).
              if (written != lastEmit || status == DownloadManager.STATUS_SUCCESSFUL) {
                lastEmit = written
                emitProgress(written, total)
              }

              when (status) {
                DownloadManager.STATUS_SUCCESSFUL -> {
                  activeDownloadId.set(-1)
                  val localUriIdx = cursor.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI)
                  val localUri = if (localUriIdx >= 0) cursor.getString(localUriIdx) else null

                  var outFile = when {
                    expectedFile.exists() && expectedFile.length() > 0L -> expectedFile
                    dest.exists() && dest.length() > 0L -> dest
                    else -> null
                  }

                  if (outFile == null && !localUri.isNullOrBlank()) {
                    val src = resolveApkFile(localUri)
                    if (src.exists() && src.length() > 0L) {
                      if (src.absolutePath != dest.absolutePath) {
                        dest.parentFile?.mkdirs()
                        src.copyTo(dest, overwrite = true)
                      }
                      outFile = dest
                    }
                  }

                  if (outFile == null || !outFile.exists() || outFile.length() == 0L) {
                    rejectOnMain(promise, "E_DOWNLOAD", "Download finished but file is empty")
                    return@execute
                  }

                  if (outFile.absolutePath != dest.absolutePath) {
                    dest.parentFile?.mkdirs()
                    outFile.copyTo(dest, overwrite = true)
                    outFile = dest
                  }

                  emitProgress(outFile.length(), outFile.length())
                  resolveOnMain(
                    promise,
                    mapOf(
                      "uri" to "file://${outFile.absolutePath}",
                      "bytes" to outFile.length(),
                    ),
                  )
                  return@execute
                }
                DownloadManager.STATUS_FAILED -> {
                  activeDownloadId.set(-1)
                  rejectOnMain(
                    promise,
                    "E_DOWNLOAD",
                    "DownloadManager failed (reason=$reason)",
                  )
                  return@execute
                }
                else -> {
                  // pending / running / paused — also mirror bytes onto dest for JS polling
                  if (written > 0 && expectedFile.exists()) {
                    // no-op; JS polls expected/dest path
                  }
                }
              }
            }
            Thread.sleep(400)
          }
        } catch (e: Exception) {
          if (downloadId >= 0) {
            try {
              val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
              dm.remove(downloadId)
            } catch (_: Exception) {
            }
            activeDownloadId.set(-1)
          }
          if (downloadCancel.get()) {
            rejectOnMain(promise, "E_CANCELLED", "cancelled")
          } else {
            rejectOnMain(promise, "E_DOWNLOAD", e.message ?: "download failed", e)
          }
        }
      }
    }

    AsyncFunction("installApk") { filePath: String, allowUserAction: Boolean, promise: Promise ->
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
          !context.packageManager.canRequestPackageInstalls()
        ) {
          promise.reject("E_NO_PERMISSION", "REQUEST_INSTALL_PACKAGES not granted", null)
          return@AsyncFunction
        }

        val apk = resolveApkFile(filePath)
        if (!apk.exists() || apk.length() == 0L) {
          promise.reject("E_APK_MISSING", "APK not found: ${apk.absolutePath}", null)
          return@AsyncFunction
        }

        if (pendingPromise.get() != null) {
          promise.reject("E_IN_FLIGHT", "Another install is already in progress", null)
          return@AsyncFunction
        }

        // API 29–30: open system installer immediately (no PackageInstaller callback).
        if (allowUserAction && Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
          UpdateCoordinator.setInteractiveInstall(true)
          val ok = UpdateCoordinator.commitInstallForJs(context, apk, allowUserAction = true)
          UpdateCoordinator.setInteractiveInstall(false)
          if (!ok) {
            val err = UpdateStateStore(context).getLastError() ?: "Install failed"
            val code = if (err.contains("REQUEST_INSTALL")) "E_NO_PERMISSION" else "E_INSTALL"
            promise.reject(code, err, null)
            return@AsyncFunction
          }
          promise.resolve(
            mapOf(
              "status" to "pending_user_action",
              "message" to "System installer opened",
            ),
          )
          return@AsyncFunction
        }

        pendingAllowUserAction.set(allowUserAction)
        pendingPromise.set(promise)
        UpdateCoordinator.setInteractiveInstall(allowUserAction)

        val ok = UpdateCoordinator.commitInstallForJs(context, apk, allowUserAction)
        if (!ok) {
          pendingPromise.compareAndSet(promise, null)
          UpdateCoordinator.setInteractiveInstall(false)
          val err = UpdateStateStore(context).getLastError() ?: "Install failed"
          val code = if (err.contains("REQUEST_INSTALL")) "E_NO_PERMISSION" else "E_INSTALL"
          promise.reject(code, err, null)
        }
      } catch (e: Exception) {
        pendingPromise.set(null)
        UpdateCoordinator.setInteractiveInstall(false)
        promise.reject("E_INSTALL", e.message, e)
      }
    }
  }

  private fun updateDir(): File {
    val base = context.getExternalFilesDir(null) ?: context.filesDir
    val dir = File(base, "flora-update")
    if (!dir.exists()) dir.mkdirs()
    return dir
  }

  private fun cancelActiveSystemDownload() {
    val id = activeDownloadId.getAndSet(-1)
    if (id < 0) return
    try {
      val dm = context.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
      dm.remove(id)
    } catch (_: Exception) {
    }
  }

  private fun resolveApkFile(filePath: String): File {
    val path = filePath.removePrefix("file://")
    return File(path)
  }

  companion object {
    private val activeModule = AtomicReference<FloraApkUpdaterModule?>(null)
    private val pendingPromise = AtomicReference<Promise?>(null)
    private val pendingAllowUserAction = AtomicReference(false)

    fun completePendingInstall(
      status: String,
      message: String?,
      confirmIntent: Intent? = null,
    ) {
      val module = activeModule.get()
      val allowUserAction = pendingAllowUserAction.get()

      when (status) {
        "success" -> {
          val promise = pendingPromise.getAndSet(null) ?: return
          promise.resolve(
            mapOf(
              "status" to "success",
              "message" to (message ?: "ok"),
            ),
          )
        }
        "pending_user_action" -> {
          val promise = pendingPromise.get() ?: return
          if (!allowUserAction) {
            pendingPromise.compareAndSet(promise, null)
            promise.reject(
              "E_USER_ACTION_REQUIRED",
              message ?: "Install requires user action",
              null,
            )
            return
          }
          // Confirm UI is started by UpdateCoordinator; keep promise for final status.
          if (confirmIntent == null) {
            pendingPromise.compareAndSet(promise, null)
            promise.reject("E_CONFIRM", "Missing confirm intent", null)
          }
        }
        "system_installer" -> {
          // Intent-based fallback after PackageInstaller Permission Denied.
          val promise = pendingPromise.getAndSet(null) ?: return
          promise.resolve(
            mapOf(
              "status" to "pending_user_action",
              "message" to (message ?: "System installer opened"),
            ),
          )
        }
        else -> {
          val promise = pendingPromise.getAndSet(null) ?: return
          promise.reject("E_INSTALL_FAILED", message ?: status, null)
        }
      }
    }
  }
}

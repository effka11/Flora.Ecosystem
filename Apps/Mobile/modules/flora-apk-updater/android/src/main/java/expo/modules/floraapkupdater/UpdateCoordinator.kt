package expo.modules.floraapkupdater

import android.app.Application
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.content.FileProvider
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Native sideload update orchestrator — download anytime (opt-in), silent install only
 * after ≥10s outside foreground (WorkManager delay survives process death).
 */
object UpdateCoordinator {
  private const val TAG = "FloraApkUpdate"
  const val INSTALL_WORK_PREFIX = "flora-apk-install-"
  const val INSTALL_DELAY_SECONDS = 10L

  private val initialized = AtomicBoolean(false)
  @Volatile private var foreground = false
  @Volatile private var interactiveInstall = false

  fun init(application: Application) {
    if (!initialized.compareAndSet(false, true)) return
    ProcessLifecycleOwner.get().lifecycle.addObserver(
      object : DefaultLifecycleObserver {
        override fun onStart(owner: LifecycleOwner) {
          foreground = true
          cancelScheduledInstalls(application)
        }

        override fun onStop(owner: LifecycleOwner) {
          foreground = false
          val store = UpdateStateStore(application)
          if (store.getPhase() == UpdatePhase.READY && canAutoInstall(application)) {
            scheduleSilentInstall(application, store.getManifest()?.versionCode)
          }
        }
      },
    )
    Log.i(TAG, "UpdateCoordinator initialized")
  }

  fun isForeground(): Boolean = foreground

  fun setInteractiveInstall(active: Boolean) {
    interactiveInstall = active
  }

  fun isInteractiveInstall(): Boolean = interactiveInstall

  fun canRequestPackageInstalls(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
    return context.packageManager.canRequestPackageInstalls()
  }

  fun canAutoInstall(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return false
    return canRequestPackageInstalls(context)
  }

  fun getState(context: Context): Map<String, Any?> {
    return UpdateStateStore(context).toJsMap()
  }

  fun updateDir(context: Context): File {
    val base = context.getExternalFilesDir(null) ?: context.filesDir
    val dir = File(base, "flora-update")
    if (!dir.exists()) dir.mkdirs()
    return dir
  }

  fun pendingApk(context: Context): File = File(updateDir(context), "pending.apk")

  fun parseManifestFromData(data: Map<String, String>): UpdateManifest? {
    val version = data["version"]?.trim().orEmpty()
    val versionCode = data["versionCode"]?.toIntOrNull() ?: return null
    val apkUrl = data["apkUrl"]?.trim().orEmpty()
    val sha256 = data["sha256"]?.trim()?.lowercase().orEmpty()
    if (version.isEmpty() || versionCode < 1 || apkUrl.isEmpty() || sha256.length != 64) {
      return null
    }
    val sizeBytes = data["sizeBytes"]?.toLongOrNull()?.takeIf { it > 0 }
    return UpdateManifest(
      version = version,
      versionCode = versionCode,
      apkUrl = apkUrl,
      sha256 = sha256,
      sizeBytes = sizeBytes,
      notificationUuid = data["notificationUuid"]?.trim(),
      text = data["text"]?.trim(),
    )
  }

  fun parseManifestFromJs(map: Map<String, Any?>): UpdateManifest? {
    val version = (map["version"] as? String)?.trim().orEmpty()
    val versionCode = when (val v = map["versionCode"]) {
      is Number -> v.toInt()
      is String -> v.toIntOrNull()
      else -> null
    } ?: return null
    val apkUrl = (map["apkUrl"] as? String)?.trim().orEmpty()
    val sha256 = (map["sha256"] as? String)?.trim()?.lowercase().orEmpty()
    if (version.isEmpty() || versionCode < 1 || apkUrl.isEmpty()) return null
    val sizeBytes = when (val s = map["sizeBytes"]) {
      is Number -> s.toLong().takeIf { it > 0 }
      is String -> s.toLongOrNull()?.takeIf { it > 0 }
      else -> null
    }
    return UpdateManifest(
      version = version,
      versionCode = versionCode,
      apkUrl = apkUrl,
      sha256 = sha256,
      sizeBytes = sizeBytes,
      notificationUuid = map["notificationUuid"] as? String,
      text = map["text"] as? String,
    )
  }

  /** FCM / catch-up / JS auto path. */
  fun startAuto(context: Context, manifest: UpdateManifest, showTray: Boolean) {
    val app = context.applicationContext
    if (!canRequestPackageInstalls(app)) {
      Log.i(TAG, "startAuto skipped: no install permission")
      if (showTray) {
        UpdateTrayNotifier.showUpdateAvailable(
          app,
          "Flora",
          manifest.text ?: "Новая версия Android - ${manifest.version}",
        )
      }
      return
    }
    if (!UpdateUrlAllowlist.isAllowed(manifest.apkUrl)) {
      fail(app, "APK URL not allowlisted")
      return
    }
    if (manifest.sha256.length != 64) {
      fail(app, "Invalid sha256")
      return
    }

    val installed = installedVersionCode(app)
    if (manifest.versionCode <= installed) {
      Log.i(TAG, "startAuto skipped: already installed ${manifest.versionCode}")
      return
    }

    val store = UpdateStateStore(app)
    val existing = store.getManifest()
    val phase = store.getPhase()
    if (existing?.versionCode == manifest.versionCode &&
      (phase == UpdatePhase.DOWNLOADING || phase == UpdatePhase.READY ||
        phase == UpdatePhase.INSTALL_SCHEDULED || phase == UpdatePhase.INSTALLING)
    ) {
      Log.i(TAG, "startAuto deduped versionCode=${manifest.versionCode} phase=$phase")
      if (phase == UpdatePhase.READY && !foreground && canAutoInstall(app)) {
        scheduleSilentInstall(app, manifest.versionCode)
      }
      return
    }

    if (showTray) {
      UpdateTrayNotifier.showUpdateAvailable(
        app,
        "Flora",
        manifest.text ?: "Новая версия Android - ${manifest.version}",
      )
    }

    store.saveManifest(manifest)
    store.clearError()
    enqueueDownload(app, manifest)
  }

  fun cancel(context: Context) {
    val app = context.applicationContext
    val store = UpdateStateStore(app)
    val id = store.getDownloadId()
    if (id >= 0) {
      try {
        val dm = app.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        dm.remove(id)
      } catch (_: Exception) {
      }
    }
    cancelScheduledInstalls(app)
    pendingApk(app).delete()
    store.resetToIdle()
  }

  fun enqueueDownload(context: Context, manifest: UpdateManifest) {
    val app = context.applicationContext
    val store = UpdateStateStore(app)
    val dest = pendingApk(app)
    dest.parentFile?.mkdirs()
    if (dest.exists()) dest.delete()

    val relativePath = "flora-update/${dest.name}"
    val request = DownloadManager.Request(Uri.parse(manifest.apkUrl))
      .setTitle("Flora")
      .setDescription("Загрузка обновления")
      .setMimeType("application/vnd.android.package-archive")
      .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
      .setAllowedOverMetered(true)
      .setAllowedOverRoaming(true)
      .setDestinationInExternalFilesDir(app, null, relativePath)

    val dm = app.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
    val id = dm.enqueue(request)
    store.setDownloadId(id)
    store.setPhase(UpdatePhase.DOWNLOADING)
    Log.i(TAG, "Download enqueued id=$id versionCode=${manifest.versionCode}")
  }

  fun onDownloadComplete(context: Context, downloadId: Long) {
    val app = context.applicationContext
    val store = UpdateStateStore(app)
    if (downloadId < 0 || downloadId != store.getDownloadId()) {
      return
    }
    val manifest = store.getManifest() ?: run {
      fail(app, "Missing manifest after download")
      return
    }

    val expected = File(app.getExternalFilesDir(null), "flora-update/pending.apk")
    val dest = pendingApk(app)
    var file = when {
      expected.exists() && expected.length() > 0L -> expected
      dest.exists() && dest.length() > 0L -> dest
      else -> null
    }
    if (file == null) {
      fail(app, "Download finished but APK missing")
      return
    }
    if (file.absolutePath != dest.absolutePath) {
      dest.parentFile?.mkdirs()
      file.copyTo(dest, overwrite = true)
      file = dest
    }

    val hash = sha256File(file)
    if (!hash.equals(manifest.sha256, ignoreCase = true)) {
      file.delete()
      fail(app, "SHA-256 mismatch")
      return
    }

    store.setDownloadId(-1)
    store.setPhase(UpdatePhase.READY)
    store.clearError()
    Log.i(TAG, "APK ready versionCode=${manifest.versionCode}")

    if (!canAutoInstall(app)) {
      UpdateTrayNotifier.showReady(app, manifest.version)
      return
    }

    if (foreground || interactiveInstall) {
      Log.i(TAG, "Defer silent install: foreground=$foreground interactive=$interactiveInstall")
      return
    }
    scheduleSilentInstall(app, manifest.versionCode)
  }

  fun scheduleSilentInstall(context: Context, versionCode: Int?) {
    val code = versionCode ?: return
    if (!canAutoInstall(context)) return
    if (foreground || interactiveInstall) return

    val store = UpdateStateStore(context)
    if (store.getPhase() != UpdatePhase.READY && store.getPhase() != UpdatePhase.INSTALL_SCHEDULED) {
      return
    }
    store.setPhase(UpdatePhase.INSTALL_SCHEDULED)

    val work = OneTimeWorkRequestBuilder<FloraApkInstallWorker>()
      .setInitialDelay(INSTALL_DELAY_SECONDS, java.util.concurrent.TimeUnit.SECONDS)
      .setInputData(workDataOf(FloraApkInstallWorker.KEY_VERSION_CODE to code))
      .build()
    WorkManager.getInstance(context).enqueueUniqueWork(
      INSTALL_WORK_PREFIX + code,
      ExistingWorkPolicy.REPLACE,
      work,
    )
    Log.i(TAG, "Scheduled silent install in ${INSTALL_DELAY_SECONDS}s versionCode=$code")
  }

  fun cancelScheduledInstalls(context: Context) {
    val store = UpdateStateStore(context)
    val code = store.getManifest()?.versionCode
    if (code != null) {
      WorkManager.getInstance(context).cancelUniqueWork(INSTALL_WORK_PREFIX + code)
    }
    if (store.getPhase() == UpdatePhase.INSTALL_SCHEDULED) {
      store.setPhase(UpdatePhase.READY)
    }
  }

  /**
   * Called from WorkManager after delay. Returns true if install was committed.
   */
  fun trySilentInstall(context: Context, expectedVersionCode: Int): Boolean {
    val app = context.applicationContext
    if (foreground || interactiveInstall) {
      Log.i(TAG, "Silent install aborted: still foreground/interactive")
      val store = UpdateStateStore(app)
      if (store.getPhase() == UpdatePhase.INSTALL_SCHEDULED) {
        store.setPhase(UpdatePhase.READY)
      }
      return false
    }
    if (!canAutoInstall(app)) return false

    val store = UpdateStateStore(app)
    val manifest = store.getManifest() ?: return false
    if (manifest.versionCode != expectedVersionCode) return false
    if (store.getPhase() != UpdatePhase.READY && store.getPhase() != UpdatePhase.INSTALL_SCHEDULED) {
      return false
    }

    val apk = pendingApk(app)
    if (!apk.exists() || apk.length() == 0L) {
      fail(app, "APK missing at install time")
      return false
    }

    return commitInstall(app, apk, allowUserAction = false, store = store)
  }

  /** Used by FloraApkUpdaterModule.installApk (JS interactive / legacy). */
  fun commitInstallForJs(context: Context, apk: File, allowUserAction: Boolean): Boolean {
    val app = context.applicationContext
    interactiveInstall = allowUserAction
    cancelScheduledInstalls(app)
    return commitInstall(app, apk, allowUserAction, UpdateStateStore(app))
  }

  fun commitInstall(
    context: Context,
    apk: File,
    allowUserAction: Boolean,
    store: UpdateStateStore,
  ): Boolean {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
        !context.packageManager.canRequestPackageInstalls() &&
        !allowUserAction
      ) {
        fail(context, "REQUEST_INSTALL_PACKAGES not granted")
        return false
      }

      val authority = "${context.packageName}.flora.apk.provider"
      FileProvider.getUriForFile(context, authority, apk)

      store.setPhase(UpdatePhase.INSTALLING)
      val installer = context.packageManager.packageInstaller
      val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        params.setRequireUserAction(
          if (allowUserAction) {
            PackageInstaller.SessionParams.USER_ACTION_REQUIRED
          } else {
            PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED
          },
        )
      }
      if (allowUserAction) {
        try {
          val method = PackageInstaller.SessionParams::class.java.getMethod(
            "setRequestDowngrade",
            Boolean::class.javaPrimitiveType,
          )
          method.invoke(params, true)
        } catch (_: Exception) {
        }
        try {
          val field = PackageInstaller.SessionParams::class.java.getDeclaredField("installFlags")
          field.isAccessible = true
          field.setInt(params, field.getInt(params) or 0x00000080)
        } catch (_: Exception) {
        }
      }

      val sessionId = installer.createSession(params)
      installer.openSession(sessionId).use { session ->
        session.openWrite("package", 0, apk.length()).use { out ->
          apk.inputStream().use { input -> input.copyTo(out) }
          session.fsync(out)
        }
        val callbackIntent = Intent(context, FloraApkInstallReceiver::class.java).apply {
          action = FloraApkInstallReceiver.ACTION
        }
        val flags = android.app.PendingIntent.FLAG_UPDATE_CURRENT or
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            android.app.PendingIntent.FLAG_MUTABLE
          } else {
            0
          }
        val pendingIntent = android.app.PendingIntent.getBroadcast(
          context,
          sessionId,
          callbackIntent,
          flags,
        )
        session.commit(pendingIntent.intentSender)
      }
      Log.i(TAG, "Install session committed allowUserAction=$allowUserAction")
      return true
    } catch (e: Exception) {
      Log.e(TAG, "commitInstall failed", e)
      fail(context, e.message ?: "Install failed")
      return false
    }
  }

  fun onInstallResult(context: Context, status: Int, message: String?, confirmIntent: Intent?) {
    val app = context.applicationContext
    val store = UpdateStateStore(app)
    when (status) {
      PackageInstaller.STATUS_SUCCESS -> {
        pendingApk(app).delete()
        store.resetToIdle()
        interactiveInstall = false
        FloraApkUpdaterModule.completePendingInstall("success", message)
      }
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        FloraApkUpdaterModule.completePendingInstall(
          "pending_user_action",
          message,
          confirmIntent,
        )
        if (confirmIntent != null) {
          try {
            confirmIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            app.startActivity(confirmIntent)
          } catch (e: Exception) {
            Log.e(TAG, "Failed to start confirm activity", e)
            fail(app, e.message ?: "Confirm UI failed")
            interactiveInstall = false
          }
        }
      }
      else -> {
        fail(app, message ?: "PackageInstaller status $status")
        interactiveInstall = false
        FloraApkUpdaterModule.completePendingInstall("failure", message)
      }
    }
  }

  private fun fail(context: Context, message: String) {
    val store = UpdateStateStore(context)
    store.setPhase(UpdatePhase.FAILED)
    store.setLastError(message)
    store.setDownloadId(-1)
    Log.w(TAG, "Update failed: $message")
  }

  fun installedVersionCode(context: Context): Int {
    return try {
      val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        context.packageManager.getPackageInfo(
          context.packageName,
          PackageManager.PackageInfoFlags.of(0),
        )
      } else {
        @Suppress("DEPRECATION")
        context.packageManager.getPackageInfo(context.packageName, 0)
      }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        info.longVersionCode.toInt()
      } else {
        @Suppress("DEPRECATION")
        info.versionCode
      }
    } catch (_: Exception) {
      0
    }
  }

  fun sha256File(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
      val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
      while (true) {
        val read = input.read(buffer)
        if (read <= 0) break
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }
}

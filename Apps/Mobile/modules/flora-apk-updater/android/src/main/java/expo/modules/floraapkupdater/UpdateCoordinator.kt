package expo.modules.floraapkupdater

import android.app.Activity
import android.app.Application
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Native sideload update orchestrator — download anytime (opt-in), silent install only
 * after ≥10s with no UI activities (WorkManager delay survives process death).
 */
object UpdateCoordinator {
  private const val TAG = "FloraApkUpdate"
  const val INSTALL_WORK_PREFIX = "flora-apk-install-"
  const val INSTALL_DELAY_SECONDS = 10L

  private val initialized = AtomicBoolean(false)
  private val startedActivities = AtomicInteger(0)
  @Volatile private var interactiveInstall = false
  /** Some OEMs return false from canRequestPackageInstalls while the process is stopping. */
  @Volatile private var installPermissionCached = false

  fun init(application: Application) {
    if (!initialized.compareAndSet(false, true)) return
    application.registerActivityLifecycleCallbacks(
      object : Application.ActivityLifecycleCallbacks {
        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}

        override fun onActivityStarted(activity: Activity) {
          val n = startedActivities.incrementAndGet()
          if (n == 1) {
            Log.i(TAG, "UI visible (activity) — cancel deferred silent install")
            cancelScheduledInstalls(application)
          }
        }

        override fun onActivityResumed(activity: Activity) {}

        override fun onActivityPaused(activity: Activity) {}

        override fun onActivityStopped(activity: Activity) {
          val n = startedActivities.updateAndGet { cur -> (cur - 1).coerceAtLeast(0) }
          if (n == 0) {
            Log.i(TAG, "UI hidden (activity) — maybe schedule silent install")
            maybeScheduleSilentInstall(application)
          }
        }

        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}

        override fun onActivityDestroyed(activity: Activity) {}
      },
    )
    // InitProvider posts after Application.onCreate — Activity may already be STARTED,
    // so activity counters alone can miss the first onStart. ProcessLifecycle is authoritative.
    ProcessLifecycleOwner.get().lifecycle.addObserver(
      object : DefaultLifecycleObserver {
        override fun onStart(owner: LifecycleOwner) {
          Log.i(TAG, "UI visible (process) — cancel deferred silent install")
          cancelScheduledInstalls(application)
        }

        override fun onStop(owner: LifecycleOwner) {
          Log.i(TAG, "UI hidden (process) — maybe schedule silent install")
          maybeScheduleSilentInstall(application)
        }
      },
    )
    // Manifest receiver can miss COMPLETE on some OEMs; dynamic backup while process lives.
    val downloadReceiver =
      object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent?) {
          if (intent?.action != DownloadManager.ACTION_DOWNLOAD_COMPLETE) return
          val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
          if (id >= 0L) onDownloadComplete(context, id)
        }
      }
    val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
    try {
      ContextCompat.registerReceiver(
        application,
        downloadReceiver,
        filter,
        ContextCompat.RECEIVER_EXPORTED,
      )
    } catch (e: Exception) {
      Log.w(TAG, "Failed to register download receiver", e)
    }

    recoverAfterInit(application)
    Log.i(
      TAG,
      "UpdateCoordinator initialized uiVisible=${isUiVisible()} " +
        "activities=${startedActivities.get()}",
    )
  }

  /**
   * True when the app UI is user-visible. Prefer ProcessLifecycle (survives late init);
   * activity count is a fast path once callbacks are attached.
   */
  fun isUiVisible(): Boolean {
    if (startedActivities.get() > 0) return true
    return try {
      ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)
    } catch (_: Exception) {
      false
    }
  }

  fun setInteractiveInstall(active: Boolean) {
    interactiveInstall = active
  }

  private fun maybeScheduleSilentInstall(context: Context) {
    val app = context.applicationContext
    // Finish download if COMPLETE broadcast was missed (common on Samsung).
    tryFinalizeDownload(app)
    if (isUiVisible() || interactiveInstall) {
      Log.i(TAG, "maybeSchedule skipped: uiVisible=${isUiVisible()} interactive=$interactiveInstall")
      return
    }
    val store = UpdateStateStore(app)
    val phase = store.getPhase()
    if (phase != UpdatePhase.READY) {
      Log.i(TAG, "maybeSchedule skipped: phase=$phase")
      return
    }
    // API 31+ required for USER_ACTION_NOT_REQUIRED; don't re-query install permission
    // here — Samsung often returns false while the process is stopping.
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      Log.i(TAG, "maybeSchedule skipped: API < 31 (silent install unsupported)")
      UpdateTrayNotifier.showReady(app, store.getManifest()?.version ?: "")
      return
    }
    scheduleSilentInstall(app, store.getManifest()?.versionCode)
  }

  /** If DownloadManager finished but we never got ACTION_DOWNLOAD_COMPLETE, promote to READY. */
  private fun tryFinalizeDownload(context: Context) {
    val app = context.applicationContext
    val store = UpdateStateStore(app)
    if (store.getPhase() != UpdatePhase.DOWNLOADING) {
      // Orphan file with saved manifest (COMPLETE missed after process death).
      val manifest = store.getManifest() ?: return
      val apk = pendingApk(app)
      if (apk.exists() &&
        apk.length() > 0L &&
        (store.getPhase() == UpdatePhase.IDLE || store.getPhase() == UpdatePhase.FAILED) &&
        manifest.versionCode > installedVersionCode(app)
      ) {
        val hash = sha256File(apk)
        if (hash.equals(manifest.sha256, ignoreCase = true)) {
          store.setDownloadId(-1)
          store.setPhase(UpdatePhase.READY)
          store.clearError()
          Log.i(TAG, "tryFinalize: orphan apk → READY")
        }
      }
      return
    }

    val id = store.getDownloadId()
    if (id >= 0L) {
      try {
        val dm = app.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        dm.query(DownloadManager.Query().setFilterById(id))?.use { cursor ->
          if (cursor.moveToFirst()) {
            val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
            if (status == DownloadManager.STATUS_SUCCESSFUL) {
              Log.i(TAG, "tryFinalize: DM SUCCESS id=$id → onDownloadComplete")
              onDownloadComplete(app, id)
              return
            }
            if (status == DownloadManager.STATUS_FAILED) {
              fail(app, "DownloadManager STATUS_FAILED")
              return
            }
          }
        }
      } catch (e: Exception) {
        Log.w(TAG, "tryFinalize: DM query failed", e)
      }
    }

    val manifest = store.getManifest() ?: return
    val apk = pendingApk(app)
    if (apk.exists() && apk.length() > 0L) {
      val expected = manifest.sizeBytes
      if (expected != null && apk.length() < expected) return
      val hash = sha256File(apk)
      if (hash.equals(manifest.sha256, ignoreCase = true)) {
        Log.i(TAG, "tryFinalize: pending.apk hash OK without COMPLETE → READY")
        store.setDownloadId(-1)
        store.setPhase(UpdatePhase.READY)
        store.clearError()
      }
    }
  }

  /**
   * After process start: finish a missed DOWNLOAD_COMPLETE, heal stuck phases, and
   * schedule silent install if APK is READY while UI is already in background.
   */
  private fun recoverAfterInit(application: Application) {
    val store = UpdateStateStore(application)
    val phase = store.getPhase()
    val apk = pendingApk(application)
    val manifest = store.getManifest()
    Log.i(
      TAG,
      "recover phase=$phase apkExists=${apk.exists()} apkBytes=${apk.length()} " +
        "manifestVc=${manifest?.versionCode} uiVisible=${isUiVisible()}",
    )

    if (manifest != null &&
      apk.exists() &&
      apk.length() > 0L &&
      (phase == UpdatePhase.DOWNLOADING || phase == UpdatePhase.IDLE || phase == UpdatePhase.FAILED)
    ) {
      val hash = sha256File(apk)
      if (hash.equals(manifest.sha256, ignoreCase = true) &&
        manifest.versionCode > installedVersionCode(application)
      ) {
        store.setDownloadId(-1)
        store.setPhase(UpdatePhase.READY)
        store.clearError()
        Log.i(TAG, "recover: verified orphan pending.apk → READY")
      } else {
        Log.w(TAG, "recover: orphan apk not usable (hash/version)")
      }
    }

    val healed = store.getPhase()
    if ((healed == UpdatePhase.INSTALL_SCHEDULED || healed == UpdatePhase.INSTALLING) &&
      apk.exists() &&
      apk.length() > 0L
    ) {
      store.setPhase(UpdatePhase.READY)
      Log.i(TAG, "recover: $healed → READY after process restart")
    }

    if (store.getPhase() == UpdatePhase.DOWNLOADING) {
      val id = store.getDownloadId()
      if (id >= 0L) {
        try {
          val dm = application.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
          dm.query(DownloadManager.Query().setFilterById(id))?.use { cursor ->
            if (cursor.moveToFirst()) {
              val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
              if (status == DownloadManager.STATUS_SUCCESSFUL) {
                Log.i(TAG, "recover: DownloadManager SUCCESS → onDownloadComplete")
                onDownloadComplete(application, id)
              }
            }
          }
        } catch (e: Exception) {
          Log.w(TAG, "recover: download query failed", e)
        }
      }
    }

    maybeScheduleSilentInstall(application)
  }

  fun isInteractiveInstall(): Boolean = interactiveInstall

  fun canRequestPackageInstalls(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true
    val ok = context.packageManager.canRequestPackageInstalls()
    if (ok) installPermissionCached = true
    // OEM quirk: live check can flip to false while process is stopping.
    return ok || installPermissionCached
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
      if (phase == UpdatePhase.READY && !isUiVisible() && canAutoInstall(app)) {
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
    val expectedId = store.getDownloadId()
    if (downloadId < 0 || downloadId != expectedId) {
      Log.w(
        TAG,
        "onDownloadComplete ignored id=$downloadId expected=$expectedId phase=${store.getPhase()}",
      )
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

    if (isUiVisible() || interactiveInstall) {
      Log.i(
        TAG,
        "Defer silent install: uiVisible=${isUiVisible()} interactive=$interactiveInstall",
      )
      return
    }
    scheduleSilentInstall(app, manifest.versionCode)
  }

  fun scheduleSilentInstall(context: Context, versionCode: Int?) {
    val code = versionCode ?: return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      Log.i(TAG, "scheduleSilentInstall skipped: API < 31")
      return
    }
    if (isUiVisible() || interactiveInstall) {
      Log.i(TAG, "scheduleSilentInstall skipped: ui/interactive")
      return
    }

    val store = UpdateStateStore(context)
    if (store.getPhase() != UpdatePhase.READY && store.getPhase() != UpdatePhase.INSTALL_SCHEDULED) {
      Log.i(TAG, "scheduleSilentInstall skipped: phase=${store.getPhase()}")
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
    if (isUiVisible() || interactiveInstall) {
      Log.i(
        TAG,
        "Silent install aborted: uiVisible=${isUiVisible()} interactive=$interactiveInstall",
      )
      val store = UpdateStateStore(app)
      if (store.getPhase() == UpdatePhase.INSTALL_SCHEDULED) {
        store.setPhase(UpdatePhase.READY)
      }
      return false
    }
    if (!canAutoInstall(app)) {
      Log.i(TAG, "Silent install aborted: canAutoInstall=false")
      return false
    }

    val store = UpdateStateStore(app)
    val manifest = store.getManifest() ?: return false
    if (manifest.versionCode != expectedVersionCode) {
      Log.i(TAG, "Silent install aborted: version mismatch")
      return false
    }
    if (store.getPhase() != UpdatePhase.READY && store.getPhase() != UpdatePhase.INSTALL_SCHEDULED) {
      Log.i(TAG, "Silent install aborted: phase=${store.getPhase()}")
      return false
    }

    val apk = pendingApk(app)
    if (!apk.exists() || apk.length() == 0L) {
      fail(app, "APK missing at install time")
      return false
    }

    Log.i(TAG, "trySilentInstall commit versionCode=$expectedVersionCode")
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
        Log.w(TAG, "Install needs user action (OEM/silent blocked): $message")
        FloraApkUpdaterModule.completePendingInstall(
          "pending_user_action",
          message,
          confirmIntent,
        )
        // Keep APK for button 2.1 / notification tap.
        store.setPhase(UpdatePhase.READY)
        val version = store.getManifest()?.version ?: ""
        if (confirmIntent != null) {
          if (interactiveInstall || isUiVisible()) {
            try {
              confirmIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
              app.startActivity(confirmIntent)
            } catch (e: Exception) {
              Log.e(TAG, "Failed to start confirm activity", e)
              UpdateTrayNotifier.showInstallConfirm(app, confirmIntent, version)
            }
          } else {
            // Background: cannot start Activity — notification with user tap.
            UpdateTrayNotifier.showInstallConfirm(app, confirmIntent, version)
          }
        } else {
          UpdateTrayNotifier.showReady(app, version)
        }
        interactiveInstall = false
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

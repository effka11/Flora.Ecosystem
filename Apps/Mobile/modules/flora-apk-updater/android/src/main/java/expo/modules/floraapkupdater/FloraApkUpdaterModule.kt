package expo.modules.floraapkupdater

import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicReference

class FloraApkUpdaterModule : Module() {
  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("FloraApkUpdater")

    OnCreate {
      activeModule.set(this@FloraApkUpdaterModule)
    }

    OnDestroy {
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
        // System UI for this permission is the per-app «Install unknown apps» screen
        // (no runtime dialog like POST_NOTIFICATIONS). Prefer current Activity so
        // returning to Flora is clean; JS awaits AppState and re-checks grant.
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

    AsyncFunction("installApk") { filePath: String, allowUserAction: Boolean, promise: Promise ->
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
          !context.packageManager.canRequestPackageInstalls()
        ) {
          if (!allowUserAction) {
            promise.reject("E_NO_PERMISSION", "REQUEST_INSTALL_PACKAGES not granted", null)
            return@AsyncFunction
          }
        }

        val apk = resolveApkFile(filePath)
        if (!apk.exists() || apk.length() == 0L) {
          promise.reject("E_APK_MISSING", "APK not found: ${apk.absolutePath}", null)
          return@AsyncFunction
        }

        // Ensure FileProvider can see the path (cache/flora-update/).
        val authority = "${context.packageName}.flora.apk.provider"
        FileProvider.getUriForFile(context, authority, apk)

        if (pendingPromise.get() != null) {
          promise.reject("E_IN_FLIGHT", "Another install is already in progress", null)
          return@AsyncFunction
        }

        pendingAllowUserAction.set(allowUserAction)
        pendingPromise.set(promise)

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

        val sessionId = installer.createSession(params)
        installer.openSession(sessionId).use { session ->
          session.openWrite("package", 0, apk.length()).use { out ->
            apk.inputStream().use { input -> input.copyTo(out) }
            session.fsync(out)
          }

          val callbackIntent = Intent(context, FloraApkInstallReceiver::class.java).apply {
            action = FloraApkInstallReceiver.ACTION
          }
          val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
          val pendingIntent = PendingIntent.getBroadcast(context, sessionId, callbackIntent, flags)
          session.commit(pendingIntent.intentSender)
        }
      } catch (e: Exception) {
        pendingPromise.set(null)
        promise.reject("E_INSTALL", e.message, e)
      }
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
          // Keep the JS promise open until SUCCESS/FAILURE after the user
          // confirms (or cancels) the system installer UI. Resolving early
          // made post-confirm failures invisible ("nothing happens").
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
          val ctx = module?.appContext?.reactContext
          if (ctx != null && confirmIntent != null) {
            confirmIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
              ctx.startActivity(confirmIntent)
            } catch (e: Exception) {
              pendingPromise.compareAndSet(promise, null)
              promise.reject("E_CONFIRM", e.message, e)
            }
          } else {
            pendingPromise.compareAndSet(promise, null)
            promise.reject("E_CONFIRM", "Missing confirm intent or context", null)
          }
        }
        else -> {
          val promise = pendingPromise.getAndSet(null) ?: return
          promise.reject("E_INSTALL_FAILED", message ?: status, null)
        }
      }
    }
  }
}

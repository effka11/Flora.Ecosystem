package expo.modules.floraapkupdater

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log

/**
 * Receives PackageInstaller session commit results and forwards them to [FloraApkUpdaterModule].
 */
class FloraApkInstallReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
    val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
    Log.d(TAG, "install status=$status message=$message")

    when (status) {
      PackageInstaller.STATUS_PENDING_USER_ACTION -> {
        val confirm = getConfirmIntent(intent)
        FloraApkUpdaterModule.completePendingInstall(
          status = "pending_user_action",
          message = message,
          confirmIntent = confirm,
        )
      }
      PackageInstaller.STATUS_SUCCESS -> {
        FloraApkUpdaterModule.completePendingInstall(status = "success", message = message)
      }
      else -> {
        FloraApkUpdaterModule.completePendingInstall(
          status = "failure",
          message = message ?: "PackageInstaller status $status",
        )
      }
    }
  }

  private fun getConfirmIntent(intent: Intent): Intent? {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
    } else {
      @Suppress("DEPRECATION")
      intent.getParcelableExtra(Intent.EXTRA_INTENT)
    }
  }

  companion object {
    private const val TAG = "FloraApkInstall"
    const val ACTION = "social.flora.mobile.FLORA_APK_INSTALL"
  }
}

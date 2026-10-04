package expo.modules.floraapkupdater

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters

class FloraApkInstallWorker(
  appContext: Context,
  params: WorkerParameters,
) : CoroutineWorker(appContext, params) {
  override suspend fun doWork(): Result {
    val versionCode = inputData.getInt(KEY_VERSION_CODE, -1)
    if (versionCode < 1) return Result.failure()
    Log.i(TAG, "Install worker running versionCode=$versionCode")
    // false = deferred (foreground) or soft fail — do not retry-loop; next background
    // transition / catch-up will schedule again.
    UpdateCoordinator.trySilentInstall(applicationContext, versionCode)
    return Result.success()
  }

  companion object {
    const val KEY_VERSION_CODE = "versionCode"
    private const val TAG = "FloraApkInstallWork"
  }
}

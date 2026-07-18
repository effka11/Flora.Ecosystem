package expo.modules.floraapkupdater

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class FloraDownloadCompleteReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != DownloadManager.ACTION_DOWNLOAD_COMPLETE) return
    val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
    if (id < 0) return
    Log.d(TAG, "DOWNLOAD_COMPLETE id=$id")
    UpdateCoordinator.onDownloadComplete(context, id)
  }

  companion object {
    private const val TAG = "FloraApkDownload"
  }
}

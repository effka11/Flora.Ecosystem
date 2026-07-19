package expo.modules.floraapkupdater

import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Handler
import android.os.Looper

/**
 * Early process hook. Init is posted to the main looper so it runs after
 * [Application.onCreate] — ProcessLifecycleOwner is unsafe from ContentProvider.onCreate.
 */
class FloraApkUpdaterInitProvider : ContentProvider() {
  override fun onCreate(): Boolean {
    val ctx = context ?: return false
    val app = ctx.applicationContext as? Application ?: return false
    Handler(Looper.getMainLooper()).post {
      UpdateCoordinator.init(app)
    }
    return true
  }

  override fun query(
    uri: Uri,
    projection: Array<out String>?,
    selection: String?,
    selectionArgs: Array<out String>?,
    sortOrder: String?,
  ): Cursor? = null

  override fun getType(uri: Uri): String? = null

  override fun insert(uri: Uri, values: ContentValues?): Uri? = null

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

  override fun update(
    uri: Uri,
    values: ContentValues?,
    selection: String?,
    selectionArgs: Array<out String>?,
  ): Int = 0
}

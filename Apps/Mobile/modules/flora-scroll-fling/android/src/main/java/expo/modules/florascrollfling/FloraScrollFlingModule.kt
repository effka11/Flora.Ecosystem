package expo.modules.florascrollfling

import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.views.scroll.ReactScrollView
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlin.math.roundToInt

class FloraScrollFlingModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("FloraScrollFling")

    Function("resumeVerticalFling") { viewTag: Int, velocityY: Double ->
      withVerticalScrollView(viewTag) { scrollView ->
        flingBy(scrollView, velocityY)
      }
    }

    /**
     * ACTION_DOWN по едущему ScrollView нативно «ловит» fling (останавливает
     * и переводит в drag за пальцем). Для edge-swipe гамбургера это не нужно:
     * синтетический ACTION_CANCEL сбрасывает drag-state (палец перестаёт
     * влиять на ленту), затем fling продолжает инерцию с прежней скоростью.
     * Вертикальный жест не страдает: RNGH при активации скролла шлёт
     * свежий synthesized DOWN, и лента ловится заново как обычно.
     */
    Function("cancelTouchAndResumeVerticalFling") { viewTag: Int, velocityY: Double ->
      withVerticalScrollView(viewTag) { scrollView ->
        dispatchCancelTouch(scrollView)
        flingBy(scrollView, velocityY)
      }
    }
  }

  private fun withVerticalScrollView(viewTag: Int, block: (ReactScrollView) -> Unit) {
    val reactContext = appContext.reactContext as? ReactContext ?: return
    UiThreadUtil.runOnUiThread {
      val view = runCatching {
        UIManagerHelper
          .getUIManagerForReactTag(reactContext, viewTag)
          ?.resolveView(viewTag)
      }.getOrNull()
      val scrollView = findVerticalScrollView(view) ?: return@runOnUiThread
      block(scrollView)
    }
  }

  private fun flingBy(scrollView: ReactScrollView, velocityY: Double) {
    val velocityPx = (velocityY * scrollView.resources.displayMetrics.density).roundToInt()
    if (velocityPx == 0) return
    scrollView.postOnAnimation {
      scrollView.fling(velocityPx)
    }
  }

  private fun dispatchCancelTouch(view: View) {
    val now = SystemClock.uptimeMillis()
    val cancel = MotionEvent.obtain(now, now, MotionEvent.ACTION_CANCEL, 0f, 0f, 0)
    view.dispatchTouchEvent(cancel)
    cancel.recycle()
  }

  private fun findVerticalScrollView(view: View?): ReactScrollView? {
    if (view is ReactScrollView) return view
    if (view !is ViewGroup) return null
    for (index in 0 until view.childCount) {
      val nested = findVerticalScrollView(view.getChildAt(index))
      if (nested != null) return nested
    }
    return null
  }
}

package expo.modules.florascrollfling

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
      val reactContext = appContext.reactContext as? ReactContext ?: return@Function
      UiThreadUtil.runOnUiThread {
        val view = runCatching {
          UIManagerHelper
            .getUIManagerForReactTag(reactContext, viewTag)
            ?.resolveView(viewTag)
        }.getOrNull()
        val scrollView = findVerticalScrollView(view) ?: return@runOnUiThread
        val velocityPx = (velocityY * scrollView.resources.displayMetrics.density).roundToInt()
        scrollView.postOnAnimation {
          scrollView.fling(velocityPx)
        }
      }
    }
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

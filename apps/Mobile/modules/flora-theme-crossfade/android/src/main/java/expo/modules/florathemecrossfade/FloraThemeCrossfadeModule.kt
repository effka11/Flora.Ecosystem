package expo.modules.florathemecrossfade

import android.animation.ValueAnimator
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.view.PixelCopy
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.animation.PathInterpolator
import android.widget.ImageView
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val TAG = "FloraThemeCrossfade"

/** JS не позвал reveal (ошибка, обрыв бандла) — снимок не должен висеть вечно. */
private const val WATCHDOG_MS = 1500L

/** Выше любого RN-`elevation`: FrameLayout рисует детей и диспатчит касания по Z. */
private const val OVERLAY_Z = 1_000_000f

/**
 * Страховка ожидания кадра новой палитры: если draw не случился (окно скрыто,
 * дерево откреплено) — растворяем снимок по таймауту, а не висим до watchdog.
 */
private const val SETTLE_TIMEOUT_MS = 120L

/**
 * --flora-ease-in: cubic-bezier(0.36, 0, 0.64, 1) — как ENERGETIC_CLOSE_EASING в JS.
 *
 * Симметричная кривая, а не ENERGETIC_OPEN_EASING (0.33, 1, 0.2, 1): «открытие»
 * отдаёт ~90% пути за первые ~25% времени, и кроссфейд 180 мс читался как
 * подмена — большинство изменения приходилось на 2–3 кадра. Здесь 10/50/90%
 * проходятся примерно за 24/50/76% длительности.
 */
private val REVEAL_INTERPOLATOR = PathInterpolator(0.36f, 0f, 0.64f, 1f)

/**
 * Кроссфейд смены темы: снимок текущего экрана (в памяти, без файлов) закрывает
 * UI, JS меняет палитру под ним, после коммита нового дерева снимок растворяется.
 *
 * Состояния: IDLE → COVERING (снимок непрозрачен, ждём reveal) → FADING → IDLE.
 * `generation` инвалидирует отложенные кадры, анимацию и watchdog прошлой сессии.
 * Все методы работают на главном потоке.
 */
class FloraThemeCrossfadeModule : Module() {
  private enum class Phase { IDLE, COVERING, FADING }

  private val mainHandler = Handler(Looper.getMainLooper())
  private var overlay: ImageView? = null
  private var phase = Phase.IDLE
  private var generation = 0
  private var watchdog: Runnable? = null

  override fun definition() = ModuleDefinition {
    Name("FloraThemeCrossfade")

    AsyncFunction("freeze") { promise: Promise ->
      freeze(promise)
    }.runOnQueue(Queues.MAIN)

    Function("reveal") { durationMs: Double ->
      postReveal(durationMs)
    }

    Function("cancel") {
      postCancel()
    }

    OnActivityDestroys {
      runOnMain { removeOverlay() }
    }

    OnDestroy {
      runOnMain { removeOverlay() }
    }
  }

  private fun postReveal(durationMs: Double) {
    val duration = if (durationMs.isFinite()) durationMs.toLong() else 0L
    runOnMain { reveal(duration) }
  }

  private fun postCancel() {
    runOnMain { removeOverlay() }
  }

  private fun runOnMain(block: () -> Unit) {
    if (Looper.myLooper() == Looper.getMainLooper()) {
      block()
    } else {
      mainHandler.post { block() }
    }
  }

  /**
   * Снять текущий экран и закрыть им UI. `true` — снимок на экране, можно менять
   * палитру. `false` — переключаться без кроссфейда: нет Activity, reduce motion,
   * ошибка readback.
   */
  private fun freeze(promise: Promise) {
    val activity = appContext.currentActivity
    if (activity == null || activity.isFinishing) {
      decline(promise, "no foreground activity")
      return
    }
    val content = activity.findViewById<ViewGroup>(android.R.id.content)
    if (content == null || content.width <= 0 || content.height <= 0) {
      decline(promise, "content is not laid out")
      return
    }
    if (isReduceMotionEnabled(activity)) {
      decline(promise, "reduce motion is enabled")
      return
    }
    val startedAt = SystemClock.uptimeMillis()

    if (phase == Phase.COVERING && overlay != null) {
      // Снимок уже непрозрачно закрывает экран, под ним ещё старая картинка — переиспользуем.
      log("freeze: reuse the covering snapshot")
      armWatchdog()
      promise.resolve(true)
      return
    }

    val session = ++generation
    cancelWatchdog()
    // FADING: полупрозрачный снимок попадёт в PixelCopy вместе с экраном — ровно
    // то, что сейчас видит пользователь, без скачка яркости.
    overlay?.animate()?.cancel()

    val bitmap = try {
      Bitmap.createBitmap(content.width, content.height, Bitmap.Config.ARGB_8888)
    } catch (error: OutOfMemoryError) {
      Log.w(TAG, "snapshot bitmap allocation failed", error)
      removeOverlay()
      promise.resolve(false)
      return
    }

    capture(activity, content, bitmap) { captured ->
      if (session != generation) {
        // Сессию отменили (cancel/destroy), пока шёл readback.
        promise.resolve(false)
        return@capture
      }
      if (!captured) {
        removeOverlay()
        promise.resolve(false)
        return@capture
      }
      showOverlay(content, bitmap)
      phase = Phase.COVERING
      armWatchdog()
      log(
        "freeze: covered ${bitmap.width}x${bitmap.height} in " +
          "${SystemClock.uptimeMillis() - startedAt}ms",
      )
      promise.resolve(true)
    }
  }

  /**
   * PixelCopy — GPU-readback уже скомпонованного кадра окна: единицы мс независимо
   * от сложности дерева, включает SurfaceView/TextureView. Без surface или на
   * API < 26 — software draw контента (video-поверхности в нём чёрные).
   */
  private fun capture(
    activity: Activity,
    content: View,
    bitmap: Bitmap,
    onDone: (Boolean) -> Unit,
  ) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val location = IntArray(2)
      content.getLocationInWindow(location)
      val source = Rect(
        location[0],
        location[1],
        location[0] + content.width,
        location[1] + content.height,
      )
      try {
        PixelCopy.request(
          activity.window,
          source,
          bitmap,
          { result ->
            if (result == PixelCopy.SUCCESS) {
              onDone(true)
            } else {
              Log.w(TAG, "PixelCopy failed ($result); falling back to software draw")
              onDone(drawInto(content, bitmap))
            }
          },
          mainHandler,
        )
        return
      } catch (error: IllegalArgumentException) {
        Log.w(TAG, "PixelCopy rejected the window; falling back to software draw", error)
      }
    }
    onDone(drawInto(content, bitmap))
  }

  private fun drawInto(content: View, bitmap: Bitmap): Boolean = try {
    content.draw(Canvas(bitmap))
    true
  } catch (error: Throwable) {
    Log.w(TAG, "software snapshot failed", error)
    false
  }

  private fun showOverlay(content: ViewGroup, bitmap: Bitmap) {
    val view = overlay ?: ImageView(content.context).apply {
      scaleType = ImageView.ScaleType.FIT_XY
      elevation = OVERLAY_Z
      // Без outline нет тени от elevation.
      outlineProvider = null
      isClickable = false
      isFocusable = false
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }
    view.setImageBitmap(bitmap)
    view.alpha = 1f
    if (view.parent == null) {
      content.addView(
        view,
        ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
      )
    }
    // Страховка от чужого Z: снимок должен рисоваться последним ребёнком content.
    view.bringToFront()
    overlay = view
  }

  /**
   * Новая палитра закоммичена на JS. Ждём кадр, в котором Fabric уже отрисовал
   * новое дерево под снимком, затем растворяем снимок. `durationMs <= 0` — убрать
   * без анимации.
   *
   * Считаем не кадры, а draw: mount Fabric едет на UI-поток отдельной задачей и на
   * 120 Гц два кадра — это ~16 мс, в которые тяжёлый экран настроек не укладывается.
   * Fade стартовал раньше нового кадра, под снимком оставалась старая палитра, и
   * переход читался как резкая подмена.
   */
  private fun reveal(durationMs: Long) {
    val view = overlay
    if (view == null) {
      log("reveal: no snapshot")
      return
    }
    if (phase != Phase.COVERING) {
      log("reveal: ignored in $phase")
      return
    }
    val content = view.parent as? ViewGroup
    if (content == null) {
      removeOverlay()
      return
    }
    phase = Phase.FADING
    cancelWatchdog()
    val session = generation
    val startedAt = SystemClock.uptimeMillis()
    awaitContentFrame(content, session) {
      if (overlay !== view) return@awaitContentFrame
      log(
        "reveal: new frame in ${SystemClock.uptimeMillis() - startedAt}ms, " +
          "fade ${durationMs}ms",
      )
      if (durationMs <= 0L) {
        removeOverlay()
        return@awaitContentFrame
      }
      view.animate()
        .alpha(0f)
        .setDuration(durationMs)
        .setInterpolator(REVEAL_INTERPOLATOR)
        .withEndAction {
          if (session == generation && overlay === view) removeOverlay()
        }
        .start()
    }
  }

  /**
   * Первый draw `content` после `invalidate()`. Mount-сообщение Fabric отправлено
   * на UI-поток раньше, чем JS позвал `reveal`, поэтому к этому кадру дерево под
   * снимком уже несёт новую палитру.
   */
  private fun awaitContentFrame(content: ViewGroup, session: Int, block: () -> Unit) {
    val observer = content.viewTreeObserver
    var fired = false
    var listener: ViewTreeObserver.OnDrawListener? = null
    var timeout: Runnable? = null

    fun finish() {
      if (fired) return
      fired = true
      timeout?.let(mainHandler::removeCallbacks)
      timeout = null
      val current = listener
      listener = null
      if (current != null) {
        // Удаление из самого onDraw приходится на dispatch — уводим в очередь.
        content.post {
          if (observer.isAlive) observer.removeOnDrawListener(current)
        }
      }
      if (session == generation) block()
    }

    val drawListener = ViewTreeObserver.OnDrawListener { finish() }
    if (!observer.isAlive) {
      if (session == generation) block()
      return
    }
    listener = drawListener
    observer.addOnDrawListener(drawListener)
    content.invalidate()

    val guard = Runnable { finish() }
    timeout = guard
    mainHandler.postDelayed(guard, SETTLE_TIMEOUT_MS)
  }

  /** Снимок отклонён: тема переключится мгновенно, без кроссфейда. */
  private fun decline(promise: Promise, reason: String) {
    log("freeze: declined ($reason)")
    promise.resolve(false)
  }

  /** Диагностика в logcat: `adb logcat -s FloraThemeCrossfade` на debug-сборке. */
  private fun log(message: String) {
    if (BuildConfig.DEBUG) Log.i(TAG, message)
  }

  private fun removeOverlay() {
    generation++
    cancelWatchdog()
    phase = Phase.IDLE
    val view = overlay ?: return
    overlay = null
    view.animate().cancel()
    (view.parent as? ViewGroup)?.removeView(view)
    // Bitmap отпускаем через GC: RenderThread ещё может держать последний кадр.
    view.setImageDrawable(null)
  }

  private fun armWatchdog() {
    cancelWatchdog()
    val session = generation
    val runnable = Runnable {
      watchdog = null
      if (session == generation && phase == Phase.COVERING) {
        Log.w(TAG, "reveal was not requested in ${WATCHDOG_MS}ms; dropping the snapshot")
        reveal(0L)
      }
    }
    watchdog = runnable
    mainHandler.postDelayed(runnable, WATCHDOG_MS)
  }

  private fun cancelWatchdog() {
    watchdog?.let { mainHandler.removeCallbacks(it) }
    watchdog = null
  }

  /** Как RN AccessibilityInfo.isReduceMotionEnabled: TRANSITION_ANIMATION_SCALE == 0. */
  private fun isReduceMotionEnabled(activity: Activity): Boolean {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ValueAnimator.areAnimatorsEnabled()) {
      return true
    }
    val raw = Settings.Global.getString(
      activity.contentResolver,
      Settings.Global.TRANSITION_ANIMATION_SCALE,
    ) ?: return false
    return raw.replace(',', '.').toFloatOrNull() == 0f
  }
}

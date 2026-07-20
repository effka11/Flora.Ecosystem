package expo.modules.florascrollfling

import android.os.SystemClock
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.widget.OverScroller
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.views.scroll.ReactScrollView
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference
import java.lang.reflect.Field
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.sign

private const val TAG = "FloraScrollFling"

/** Длительность покадрового монитора coast после флипа меню (кадров, ~650 мс). */
private const val MONITOR_FRAMES = 40

/** Сколько кадров подряд позиция должна замереть, чтобы счесть coast убитым. */
private const val MONITOR_STILL_FRAMES = 2

/** Максимум перезапусков fling за одно окно монитора (защита от патологий). */
private const val ENSURE_MAX_REFLINGS = 3

/** Ниже этой скорости (px/s) coast не реанимируем — лента почти стоит. */
private const val MIN_RESUME_VELOCITY_PX = 60f

/** Санити-потолок скорости скроллера (px/s). */
private const val MAX_PLAUSIBLE_VELOCITY_PX = 100_000f

class FloraScrollFlingModule : Module() {
  private var scrollerFieldResolved = false
  private var scrollerField: Field? = null

  private val guards = LinkedHashMap<Int, GuardEntry>()
  private var guardSession: GuardSession? = null
  private var windowCallbackInstalled = false

  /** Инкремент на каждый ACTION_DOWN — инвалидирует отложенные ensure-проверки. */
  private var ensureGeneration = 0

  /** Инкремент на каждый запуск монитора — активен только последний. */
  private var monitorSerial = 0

  /** Скроллер, летевший на момент DOWN текущего жеста (для детекта catch). */
  private var flingingBeforeDispatch: OverScroller? = null

  /**
   * Последний DOWN сам остановил ленту (native catch/тап-стоп): такой стоп —
   * воля пальца, мониторы его не переигрывают. Kill от React-коммита меню
   * приходит без касания и этим флагом не помечается.
   */
  private var fingerCaughtFling = false

  override fun definition() = ModuleDefinition {
    Name("FloraScrollFling")

    Function("resumeVerticalFling") { viewTag: Int, velocityY: Double ->
      withVerticalScrollView(viewTag) { scrollView ->
        flingByPx(scrollView, dpToPx(scrollView, velocityY))
      }
    }

    /**
     * Синтетический ACTION_CANCEL сбрасывает drag-state ScrollView, затем
     * fling продолжает инерцию. Ручной инструмент; основной путь для
     * edge-swipe — edge fling guard (fling перехватывается до катча).
     */
    Function("cancelTouchAndResumeVerticalFling") { viewTag: Int, velocityY: Double ->
      withVerticalScrollView(viewTag) { scrollView ->
        val velocityPx = resolveResumeVelocityPx(scrollView, velocityY)
        dispatchCancelTouch(scrollView)
        flingByPx(scrollView, velocityPx)
      }
    }

    /**
     * Страховка вокруг флипа меню (открытие/закрытие): покадровый монитор
     * ~650 мс следит за scrollY; если позиция замерла на 2 кадра при живой
     * скорости — мгновенный re-fling со скоростью OverScroller на момент
     * смерти. Пока лента едет, монитор ничего не трогает. Любое новое
     * касание отменяет монитор (остановку пальцем не переигрываем).
     */
    Function("ensureVerticalFlingAlive") { viewTag: Int, velocityY: Double ->
      withVerticalScrollView(viewTag) { scrollView ->
        startCoastMonitor(scrollView, velocityY)
      }
    }

    /**
     * Edge fling guard. RNGH доставляет касания в ReactScrollView напрямую
     * через onTouchEvent (NativeViewGestureHandler.sendTouchEvent), поэтому
     * заслон на уровне view невозможен. Перехватываем раньше всех — в
     * Window.Callback активити: DOWN в левой полосе edgeWidthDp по летящей
     * ленте синхронно забирает fling (реальный OverScroller останавливается,
     * та же физика продолжается нашим драйвером через scrollTo). Для
     * ScrollView лента «стоит»: onInterceptTouchEvent(DOWN) → false, катч и
     * springBack не случаются, палец не влияет. Вертикальный сдвиг
     * > verticalSlopDp останавливает драйвер — нативная «поимка» пальцем
     * сохраняется. На UP/CANCEL инерция возвращается нативным fling().
     */
    Function("installEdgeFlingGuard") { viewTag: Int, edgeWidthDp: Double, verticalSlopDp: Double ->
      withVerticalScrollView(viewTag) { scrollView ->
        val density = scrollView.resources.displayMetrics.density
        guards[viewTag] = GuardEntry(
          viewRef = WeakReference(scrollView),
          edgeWidthPx = (edgeWidthDp * density).toFloat(),
          verticalSlopPx = (verticalSlopDp * density).toFloat(),
        )
        ensureWindowCallback()
      }
    }

    /**
     * Снимает регистрацию, но НЕ трогает активную guard-сессию: JS-эффект
     * переустанавливает guard на каждом ререндере ленты (в т.ч. в момент
     * открытия меню), и остановка драйвера здесь замораживала бы ленту
     * посреди жеста. Сессия завершится сама на UP/CANCEL или когда
     * инерция закончится.
     */
    Function("uninstallEdgeFlingGuard") { viewTag: Int ->
      UiThreadUtil.runOnUiThread {
        guards.remove(viewTag)
      }
    }
  }

  private class GuardEntry(
    val viewRef: WeakReference<ReactScrollView>,
    val edgeWidthPx: Float,
    val verticalSlopPx: Float,
  )

  private class GuardSession(
    val scrollView: ReactScrollView,
    val verticalSlopPx: Float,
    val downRawX: Float,
    val downRawY: Float,
    val driver: EdgeFlingDriver,
  ) {
    /** Жест распознан как горизонтальный (drawer): handover больше не проверяем. */
    var lockedHorizontal = false
  }

  /**
   * Продолжает инерцию ленты вне реального скроллера ScrollView: тот же
   * OverScroller (та же физика/трение), позиция применяется scrollTo на
   * каждом кадре. onScrollChanged у ReactScrollView продолжает эмитить
   * события — для JS coast непрерывен.
   */
  private class EdgeFlingDriver(private val scrollView: ReactScrollView) {
    private val scroller = OverScroller(scrollView.context)
    private var running = false

    private val frame = object : Runnable {
      override fun run() {
        if (!running) return
        if (scroller.computeScrollOffset()) {
          scrollView.scrollTo(scrollView.scrollX, scroller.currY)
          scrollView.postOnAnimation(this)
        } else {
          running = false
        }
      }
    }

    fun start(velocityY: Float) {
      val child = scrollView.getChildAt(0) ?: return
      val maxY = (child.height - scrollView.height).coerceAtLeast(0)
      scroller.fling(0, scrollView.scrollY, 0, velocityY.roundToInt(), 0, 0, 0, maxY)
      running = true
      scrollView.postOnAnimation(frame)
    }

    fun stop() {
      running = false
      if (!scroller.isFinished) scroller.abortAnimation()
    }

    /** Текущая скорость со знаком; 0, если инерция уже закончилась. */
    fun velocityWithSign(): Float {
      if (scroller.isFinished) return 0f
      val direction = sign((scroller.finalY - scroller.currY).toFloat())
      if (direction == 0f) return 0f
      return scroller.currVelocity * direction
    }
  }

  private class GuardWindowCallback(
    private val original: Window.Callback,
    private val beforeTouch: (MotionEvent) -> Unit,
    private val afterTouch: (MotionEvent) -> Unit,
  ) : Window.Callback by original {
    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
      beforeTouch(event)
      val handled = original.dispatchTouchEvent(event)
      afterTouch(event)
      return handled
    }
  }

  private fun ensureWindowCallback() {
    if (windowCallbackInstalled) return
    val activity = appContext.currentActivity ?: return
    val window = activity.window ?: return
    val original = window.callback ?: return
    if (original is GuardWindowCallback) {
      windowCallbackInstalled = true
      return
    }
    window.callback = GuardWindowCallback(original, ::onWindowTouchBefore, ::onWindowTouchAfter)
    windowCallbackInstalled = true
    Log.d(TAG, "edge-guard window callback installed")
  }

  private fun onWindowTouchAfter(event: MotionEvent) {
    if (event.actionMasked != MotionEvent.ACTION_DOWN) return
    val scroller = flingingBeforeDispatch
    flingingBeforeDispatch = null
    // Летел до диспатча и остановился внутри него — палец поймал ленту.
    fingerCaughtFling = scroller != null && scroller.isFinished
  }

  /** Первый зарегистрированный видимый ScrollView с летящим скроллером. */
  private fun firstFlingingGuardedScroller(): OverScroller? {
    for (entry in guards.values) {
      val view = entry.viewRef.get() ?: continue
      if (!view.isAttachedToWindow || !view.isShown) continue
      val scroller = resolveScroller(view) ?: continue
      if (!scroller.isFinished) return scroller
    }
    return null
  }

  private fun onWindowTouchBefore(event: MotionEvent) {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        ensureGeneration++
        fingerCaughtFling = false
        maybeStartGuardSession(event)
        // Takeover сам останавливает скроллер — это не catch пальцем.
        flingingBeforeDispatch =
          if (guardSession == null) firstFlingingGuardedScroller() else null
      }
      MotionEvent.ACTION_MOVE -> {
        val session = guardSession ?: return
        if (session.lockedHorizontal) return
        val dx = abs(event.rawX - session.downRawX)
        val dy = abs(event.rawY - session.downRawY)
        // Зеркало classifyDrawerEdgeIntent: вертикаль побеждает только когда
        // доминирует над горизонталью. У живого горизонтального свайпа дрейф
        // по Y легко превышает слоп — это НЕ повод отдавать ленту пальцу.
        if (dy > session.verticalSlopPx && dy > dx) {
          // Вертикальный жест: драйвер останавливается, лента замирает на
          // месте — дальше её нативно «ловит» палец (intercept-MOVE + drag).
          session.driver.stop()
          guardSession = null
          Log.d(TAG, "guard: vertical handover dx=$dx dy=$dy")
        } else if (dx > session.verticalSlopPx && dx > dy) {
          session.lockedHorizontal = true
        }
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        val session = guardSession ?: return
        guardSession = null
        val velocity = session.driver.velocityWithSign()
        session.driver.stop()
        if (abs(velocity) >= 1f) {
          // Палец ушёл — возвращаем инерцию реальному скроллеру: дальше
          // всё нативно (tap-to-stop, momentum-события, конец ленты).
          session.scrollView.fling(velocity.roundToInt())
          Log.d(TAG, "guard: handback fling v=$velocity")
          // React-коммит открытия меню может тут же убить этот fling —
          // армируем сторож сразу, без ожидания JS-вызова.
          val density = session.scrollView.resources.displayMetrics.density
          session.scrollView.postOnAnimation {
            startCoastMonitor(session.scrollView, (velocity / density).toDouble())
          }
        }
      }
    }
  }

  private fun maybeStartGuardSession(event: MotionEvent) {
    if (guardSession != null) return
    for (entry in guards.values) {
      val scrollView = entry.viewRef.get() ?: continue
      if (!scrollView.isAttachedToWindow || !scrollView.isShown) continue
      val scroller = resolveScroller(scrollView) ?: continue
      if (scroller.isFinished) continue
      val location = IntArray(2)
      scrollView.getLocationOnScreen(location)
      val x = event.rawX
      val y = event.rawY
      if (x < location[0] || x > location[0] + entry.edgeWidthPx) continue
      if (y < location[1] || y > location[1] + scrollView.height) continue
      val direction = sign((scroller.finalY - scroller.currY).toFloat())
      val velocity = scroller.currVelocity * direction
      if (direction == 0f || !velocity.isFinite() || abs(velocity) < 1f) continue
      if (abs(velocity) > MAX_PLAUSIBLE_VELOCITY_PX) continue
      // Забираем fling до того, как ScrollView увидит DOWN: реальный
      // скроллер останавливается (isFinished=true → катчить нечего),
      // движение бесшовно продолжает драйвер с той же скоростью.
      scroller.abortAnimation()
      val driver = EdgeFlingDriver(scrollView)
      driver.start(velocity)
      guardSession = GuardSession(scrollView, entry.verticalSlopPx, x, y, driver)
      Log.d(TAG, "guard: takeover v=$velocity")
      return
    }
  }

  /**
   * Покадровый сторож coast: ловит abort реального OverScroller (переход
   * isFinished false→true при живой currVelocity — естественная остановка
   * приходит с угасшей скоростью) и перезапускает fling в тот же кадр.
   * Fallback — детект по замершему scrollY, если скроллер недоступен.
   */
  private fun startCoastMonitor(scrollView: ReactScrollView, fallbackVelocityDp: Double) {
    val serial = ++monitorSerial
    val generation = ensureGeneration
    val scroller = resolveScroller(scrollView)
    val monitor = object : Runnable {
      private var framesLeft = MONITOR_FRAMES
      private var lastY = scrollView.scrollY
      private var stillFrames = 0
      private var reflings = 0
      private var firstFrame = true
      private var wasRunning = scroller != null && !scroller.isFinished

      override fun run() {
        // Новое касание (тап-стоп, catch пальцем) или более свежий монитор
        // отменяют этот: остановку пальцем не переигрываем.
        if (serial != monitorSerial || generation != ensureGeneration) return
        val finished = scroller?.isFinished
        val y = scrollView.scrollY
        var died = false
        if (finished != null) {
          if (finished && wasRunning) died = true
          // Kill успел прилететь до первого кадра монитора (JS-вызов страховки
          // после коммита): скроллер уже мёртв, но остановил его не палец.
          if (finished && firstFrame && !fingerCaughtFling) died = true
          wasRunning = !finished
        } else {
          // Скроллер недоступен: смерть по замершей позиции (2 кадра).
          if (y != lastY) {
            stillFrames = 0
          } else {
            stillFrames++
            if (stillFrames >= MONITOR_STILL_FRAMES) {
              died = true
              stillFrames = 0
            }
          }
        }
        lastY = y
        firstFrame = false
        if (died && reflings < ENSURE_MAX_REFLINGS) {
          val velocityPx = resolveResumeVelocityPx(scrollView, fallbackVelocityDp)
          // Скорость угасла ниже порога — лента доехала сама, всё честно.
          if (abs(velocityPx) < MIN_RESUME_VELOCITY_PX) return
          Log.d(TAG, "monitor: fling aborted by menu flip, instant re-fling vy=$velocityPx")
          scrollView.fling(velocityPx.roundToInt())
          reflings++
          wasRunning = true
        }
        if (--framesLeft > 0) scrollView.postOnAnimation(this)
      }
    }
    scrollView.postOnAnimation(monitor)
  }

  /**
   * Скорость для рестарта: |v| из OverScroller.getCurrVelocity() (истинная
   * физика последнего кадра, переживает abort), знак из JS-оценки (worklet
   * фильтрует offset-коррекции FlashList и надёжен по направлению).
   */
  private fun resolveResumeVelocityPx(
    scrollView: ReactScrollView,
    fallbackVelocityDp: Double,
  ): Float {
    val fallbackPx = dpToPx(scrollView, fallbackVelocityDp)
    val magnitude = runCatching { resolveScroller(scrollView)?.currVelocity }.getOrNull()
    if (
      magnitude == null ||
      !magnitude.isFinite() ||
      magnitude < 1f ||
      magnitude > MAX_PLAUSIBLE_VELOCITY_PX
    ) {
      Log.d(TAG, "velocity: js fallback=$fallbackPx (scroller=$magnitude)")
      return fallbackPx
    }
    val direction = if (fallbackPx != 0f) sign(fallbackPx) else 1f
    Log.d(TAG, "velocity: scroller=$magnitude js=$fallbackPx")
    return direction * magnitude
  }

  private fun resolveScroller(scrollView: ReactScrollView): OverScroller? {
    val field = resolveScrollerField(scrollView) ?: return null
    return runCatching { field.get(scrollView) as? OverScroller }.getOrNull()
  }

  /** Поле типа OverScroller — сперва в ReactScrollView (RN сам кэширует его туда). */
  private fun resolveScrollerField(scrollView: ReactScrollView): Field? {
    if (scrollerFieldResolved) return scrollerField
    scrollerFieldResolved = true
    var cls: Class<*>? = scrollView.javaClass
    while (cls != null) {
      val field = cls.declaredFields.firstOrNull {
        OverScroller::class.java.isAssignableFrom(it.type)
      }
      if (field != null) {
        scrollerField = runCatching { field.apply { isAccessible = true } }.getOrNull()
        if (scrollerField == null) {
          Log.w(TAG, "OverScroller field is not accessible on ${cls.name}")
        }
        return scrollerField
      }
      cls = cls.superclass
    }
    Log.w(TAG, "OverScroller field not found for ${scrollView.javaClass.name}")
    return null
  }

  private fun dpToPx(scrollView: ReactScrollView, velocityDp: Double): Float =
    (velocityDp * scrollView.resources.displayMetrics.density).toFloat()

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

  private fun flingByPx(scrollView: ReactScrollView, velocityPx: Float) {
    val velocity = velocityPx.roundToInt()
    if (velocity == 0) return
    scrollView.postOnAnimation {
      scrollView.fling(velocity)
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

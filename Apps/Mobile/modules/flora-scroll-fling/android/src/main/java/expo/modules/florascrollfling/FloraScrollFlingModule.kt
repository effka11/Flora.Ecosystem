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

/** Потолок жизни покадрового сторожа coast (кадров, ~30 с — санити-предел). */
private const val MONITOR_MAX_FRAMES = 1800

/** Сколько кадров подряд позиция должна замереть, чтобы счесть coast убитым. */
private const val MONITOR_STILL_FRAMES = 2

/** Максимум перезапусков fling за одно окно монитора (защита от патологий). */
private const val ENSURE_MAX_REFLINGS = 3

/**
 * Сколько кадров после обнаруженного kill монитор пытается перезапустить
 * fling. Проверка края в момент коммита видит схлопнутую высоту контента
 * FlashList — повтор через кадр-два попадает в уже восстановленную разметку.
 */
private const val RECOVER_TRY_FRAMES = 8

/**
 * Живость сторожа для дедупликации (мс). Во время React-коммита кадры не
 * приходят по 150–200 мс (двойной стол — до ~400): пока heartbeat моложе
 * окна, сторож считается живым и повторные запуски — no-op. Иначе JS-страховка,
 * прилетевшая сразу после стола, инвалидирует рабочий сторож новым serial —
 * до того, как тот увидит смерть скроллера (и новый стартует уже слепым:
 * скроллер мёртв, направление неизвестно, контент схлопнут коммитом).
 */
private const val MONITOR_HEARTBEAT_FRESH_MS = 600L

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

  /**
   * Drawer перекрывает ленту: его panel/backdrop получают касания, а не feed.
   * Volatile нужен, потому что значение приходит с JS, а читается UI callback.
   */
  @Volatile
  private var drawerOverlayPresented = false

  /** Инвалидирует сторожа при намеренном catch/handover или edge-takeover. */
  private var ensureGeneration = 0

  /** Инкремент на каждый запуск монитора — активен только последний. */
  private var monitorSerial = 0

  /** View, uptime и generation последнего кадра живого сторожа (дедуп запусков). */
  private var monitorHeartbeatView: WeakReference<ReactScrollView>? = null
  private var monitorHeartbeatMs = 0L
  private var monitorHeartbeatGeneration = -1

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
     * Страховка вокруг флипа меню (открытие/закрытие): монитор живёт вместе
     * с coast и перезапускает убитый fling со скоростью OverScroller на
     * момент смерти. Пока лента едет, монитор ничего не трогает. Намеренный
     * catch ленты или vertical handover отменяет монитор.
     */
    Function("ensureVerticalFlingAlive") { viewTag: Int, velocityY: Double ->
      withVerticalScrollView(viewTag) { scrollView ->
        startCoastMonitor(scrollView, velocityY)
      }
    }

    Function("setDrawerOverlayPresented") { presented: Boolean ->
      drawerOverlayPresented = presented
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
  }

  private fun onWindowTouchAfter(event: MotionEvent) {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        val scroller = flingingBeforeDispatch
        flingingBeforeDispatch = null
        // Летел до диспатча и остановился внутри него — палец поймал ленту
        // (катч/тап-стоп). Исключение — представленный drawer: его panel и
        // backdrop перекрывают feed, поэтому остановка ScrollView во время
        // такого DOWN побочна и сторож должен восстановить coast.
        val stoppedDuringDispatch = scroller != null && scroller.isFinished
        fingerCaughtFling = stoppedDuringDispatch && !drawerOverlayPresented
        if (fingerCaughtFling) {
          ensureGeneration++
        }
      }
      MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
        // Любой жест, после которого лента летит (flick пальцем или handback
        // guard-сессии), взводит сторож на весь coast: kill от React-коммита
        // меню может прилететь в любой момент — открытие, закрытие, поздние
        // коррекции. Пока инерция жива, сторож перезапускает её в тот же кадр.
        val flinging = firstFlingingGuardedView() ?: return
        startCoastMonitor(flinging, 0.0)
      }
    }
  }

  /** Первый зарегистрированный видимый ScrollView с летящим скроллером. */
  private fun firstFlingingGuardedView(): ReactScrollView? {
    for (entry in guards.values) {
      val view = entry.viewRef.get() ?: continue
      if (!view.isAttachedToWindow || !view.isShown) continue
      val scroller = resolveScroller(view) ?: continue
      if (!scroller.isFinished) return view
    }
    return null
  }

  private fun onWindowTouchBefore(event: MotionEvent) {
    when (event.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        fingerCaughtFling = false
        maybeStartGuardSession(event)
        // Takeover сам останавливает скроллер — это не catch пальцем.
        flingingBeforeDispatch =
          if (guardSession == null) {
            firstFlingingGuardedView()?.let { resolveScroller(it) }
          } else {
            null
          }
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
          // Палец взял ленту — сторожа гасим, как при катче.
          session.driver.stop()
          guardSession = null
          ensureGeneration++
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
          // Сторож взводится в after-хуке этого же UP (лента снова летит).
          session.scrollView.fling(velocity.roundToInt())
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
      // Иначе живой монитор примет этот abort за kill и перезапустит реальный
      // скроллер параллельно драйверу: два скроллера дерутся за scrollY, а
      // flywheel OverScroller на handback суммирует их скорости (2×).
      ensureGeneration++
      val driver = EdgeFlingDriver(scrollView)
      driver.start(velocity)
      guardSession = GuardSession(scrollView, entry.verticalSlopPx, x, y, driver)
      return
    }
  }

  /**
   * Покадровый сторож coast: живёт, пока жива инерция ленты, и ловит abort
   * реального OverScroller (переход isFinished false→true при живой
   * currVelocity — естественная остановка приходит с угасшей скоростью),
   * перезапуская fling в тот же кадр. Kill от React-коммита меню может
   * прилететь в любой момент coast — открытие, закрытие, поздние коррекции —
   * поэтому окно не фиксировано. Направление рестарта — знак последнего
   * наблюдённого сдвига scrollY (истинное движение, переживает abort);
   * fallbackVelocityDp — резерв, когда сдвига ещё не видели (kill до первого
   * кадра). Любое новое касание отменяет сторож: остановку пальцем и жесты
   * не переигрываем.
   */
  private fun startCoastMonitor(scrollView: ReactScrollView, fallbackVelocityDp: Double) {
    // Активная guard-сессия сама ведёт ленту драйвером (реальный скроллер
    // намеренно остановлен) — сторож тут запустил бы паразитный fling.
    if (guardSession?.scrollView === scrollView) {
      return
    }
    // Живой сторож той же generation уже висит на этой ленте — не сбрасываем
    // (он хранит направление и wasRunning; новый после коммит-стола стартовал
    // бы слепым). Смена generation (новое касание) даёт новому дорогу сразу.
    if (
      monitorHeartbeatView?.get() === scrollView &&
      monitorHeartbeatGeneration == ensureGeneration &&
      SystemClock.uptimeMillis() - monitorHeartbeatMs < MONITOR_HEARTBEAT_FRESH_MS
    ) {
      return
    }
    val serial = ++monitorSerial
    val generation = ensureGeneration
    val scroller = resolveScroller(scrollView)
    monitorHeartbeatView = WeakReference(scrollView)
    monitorHeartbeatMs = SystemClock.uptimeMillis()
    monitorHeartbeatGeneration = generation
    val monitor = object : Runnable {
      private var framesLeft = MONITOR_MAX_FRAMES
      private var lastY = scrollView.scrollY
      private var stillFrames = 0
      private var reflings = 0
      private var firstFrame = true
      private var wasRunning = scroller != null && !scroller.isFinished

      /** Осталось кадров на попытки восстановления после обнаруженного kill. */
      private var recoverFramesLeft = 0

      /**
       * Направление coast засеивается сразу: kill может прилететь до первого
       * кадра монитора, когда сдвиг ещё не наблюдался.
       */
      private var lastDir = when {
        scroller != null && !scroller.isFinished ->
          sign((scroller.finalY - scroller.currY).toFloat()).toInt()
        else -> 0
      }

      override fun run() {
        // Более свежий сторож или новое касание ленты (тап-стоп, catch,
        // vertical handover — generation растёт) отменяют этот: остановку
        // пальцем не переигрываем.
        if (serial != monitorSerial || generation != ensureGeneration) return
        if (!scrollView.isAttachedToWindow) return
        monitorHeartbeatMs = SystemClock.uptimeMillis()
        val finished = scroller?.isFinished
        val y = scrollView.scrollY
        if (finished == false) {
          // Направление — намерение живого скроллера. Сдвиги scrollY для этого
          // непригодны: коррекции FlashList двигают позицию против coast.
          val towardFinal = sign((scroller.finalY - scroller.currY).toFloat())
          if (towardFinal != 0f) lastDir = towardFinal.toInt()
        } else if (finished == null && y != lastY) {
          lastDir = if (y > lastY) 1 else -1
        }
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
        if (died) {
          recoverFramesLeft = RECOVER_TRY_FRAMES
        }
        if (recoverFramesLeft > 0 && finished != false) {
          recoverFramesLeft--
          tryRecover()
        } else if (finished == true && recoverFramesLeft == 0) {
          // Естественный конец инерции — сторож больше не нужен.
          return
        }
        if (--framesLeft > 0) scrollView.postOnAnimation(this)
      }

      /**
       * Перезапуск убитого fling. Может не удаться в кадре kill-а (FlashList
       * в момент коммита схлопывает контент — «край» ложный); тогда повтор
       * на следующих кадрах окна RECOVER_TRY_FRAMES, пока разметка не
       * восстановится.
       */
      private fun tryRecover() {
        if (reflings >= ENSURE_MAX_REFLINGS) {
          recoverFramesLeft = 0
          return
        }
        val velocityPx = monitorResumeVelocityPx()
        // Скорость угасла ниже порога — лента доехала сама, всё честно.
        if (velocityPx == null) {
          recoverFramesLeft = 0
          return
        }
        // Край контента по ходу движения: в кадре коммита он может быть
        // ложным (контент схлопнут) — не сдаёмся, пробуем в следующем кадре.
        if (atContentEdge(velocityPx)) {
          return
        }
        scrollView.fling(velocityPx.roundToInt())
        reflings++
        wasRunning = true
        recoverFramesLeft = 0
      }

      /** Лента у края контента по ходу движения (ехать дальше некуда). */
      private fun atContentEdge(velocityPx: Float): Boolean {
        val child = scrollView.getChildAt(0) ?: return true
        val maxY = (child.height - scrollView.height).coerceAtLeast(0)
        val y = scrollView.scrollY
        return (velocityPx < 0 && y <= 1) || (velocityPx > 0 && y >= maxY - 1)
      }

      /**
       * |v| из OverScroller.getCurrVelocity() (истинная физика последнего
       * кадра, переживает abort); знак — из наблюдённого движения, резерв —
       * JS-оценка. null — реанимировать нечего.
       */
      private fun monitorResumeVelocityPx(): Float? {
        val fallbackPx = dpToPx(scrollView, fallbackVelocityDp)
        val magnitude = runCatching { scroller?.currVelocity }.getOrNull()
        if (
          magnitude == null ||
          !magnitude.isFinite() ||
          magnitude > MAX_PLAUSIBLE_VELOCITY_PX
        ) {
          return if (abs(fallbackPx) >= MIN_RESUME_VELOCITY_PX) fallbackPx else null
        }
        if (magnitude < MIN_RESUME_VELOCITY_PX) return null
        val direction = if (lastDir != 0) lastDir.toFloat() else sign(fallbackPx)
        if (direction == 0f) return null
        return direction * magnitude
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
      return fallbackPx
    }
    val direction = if (fallbackPx != 0f) sign(fallbackPx) else 1f
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

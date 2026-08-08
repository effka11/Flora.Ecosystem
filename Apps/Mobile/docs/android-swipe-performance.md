# Плавность свайпов на Android (Fabric): разбор и методика

Кейс: пейджер подвкладок настроек (`app/(tabs)/settings/index.tsx`), август 2026.
Симптом — свайп «дёргается», тап по вкладке плавный, лента (эталон) плавная.
Результат оптимизации на реальном устройстве (Samsung, 120 Гц, dev-сборка), одинаковый
сценарий свайпа по зоне полей ввода:

| Метрика (dumpsys gfxinfo) | До | После |
|---|---|---|
| Janky-кадры | 27.5% | 10.7% |
| p90 кадра | 20 мс | 9 мс |
| p95 / p99 | 24 / 32 мс | 13 / 21 мс |

Бюджет кадра на 120 Гц — **8.3 мс**. Кадры 9–13 мс — один пропущенный vsync
(почти незаметно); видимое «дёргание» — это 20+ мс, несколько vsync подряд.

## Причина 1: анимация `color` текста = Fabric-коммит на каждый touch-move

`useAnimatedStyle` с `interpolateColor` на подписях вкладок (7 шт., от `scrollX`).
На Fabric **цвет текста — не прямое view-свойство**: обновление идёт через коммит
shadow-дерева — клон Paragraph-узла, перемер текста, диф, маунт. В atrace это видно как
`IntBufferBatchMountItem ... UPDATE_STATE` + `ReactTextViewManager.updateState` +
`ReactTextView.setText` **внутри** `dispatchInputEvent MotionEvent MOVE`, а C++-часть
коммита — неразмеченные ~8 мс перед Java-маунтом. Итог: ~8–10 мс UI-потока на каждое
движение пальца. Стоимость растёт с размером shadow-дерева (у настроек смонтированы
все 7 тяжёлых секций).

Почему тап был плавный: при settle-анимации нет touch-событий — обновления приходят
раз в кадр из Choreographer, а не на каждый input event.

**Правило.** Per-frame анимации — только «прямые» свойства: `transform`, `opacity`.
Кроссфейд цвета текста — двумя слоями текста: статичный в цвете A снизу + копия в
цвете B сверху с анимируемой opacity. Композиция `a·B + (1−a)·A` — та же линейная
интерполяция, что у `interpolateColor`. Реализация: `SettingsSectionTabLabel`.

Сюда же (из предыдущих раундов этой оптимизации):

- ширину индикатора вкладок не анимировать через `width` (layout-свойство → Yoga на
  каждый кадр) — только `translateX` + `scaleX` от базовой ширины;
- `removeClippedSubviews` не ставить на контейнер, который едет в `translateX`:
  клиппинг Android не пересчитывается по трансформу предка — детач/аттач целых
  страниц mid-pan и «пустые» страницы.

## Причина 2: RN-виджеты под пальцем не отменяются при активации pan

Свайп начинается на вертикальном `ScrollView` / `TextInput` страницы. Виджеты из
`react-native` не участвуют в оркестрации RNGH: когда pager-pan активируется, они
**продолжают обрабатывать move-события**. Худший случай — `EditText`: горизонтальное
ведение он считает перетаскиванием курсора и рисует **лупу выделения** — PopupWindow
324×324 с `copySurfaceInto` и блокирующим `postAndWait` по 13–15 мс на кадр, плюс
connect/disconnect Surface внутри `View#onTouchEvent` (~9 мс). В atrace:
`draw-VRI[PopupWindow:...]`, `copySurfaceInto`, `topSelectionChange`.

**Правило.** Всё скроллящееся/редактируемое внутри пейджера — из
`react-native-gesture-handler`: `ScrollView`, `TextInput`. Тогда при активации pan
RNGH шлёт им ACTION_CANCEL детерминированно на UI-потоке. Дополнительно, как в ленте
(`lib/useCollapsibleHeader.tsx`): `overScrollMode="never"` на неактивных страницах
(EdgeEffect не должен жить на страницах, едущих в translateX) и не включать
`nestedScrollEnabled` без реальной вложенности скроллов.

## Дисциплина маунта тяжёлых страниц

Fabric-маунт тяжёлой вкладки идёт на Android main thread и роняет кадры жеста:

- не маунтить, пока экраном владеет касание или анимация — busy-guard из счётчика
  касаний + флагов движения (pager/strip); `InteractionManager` жесты RNGH/Reanimated
  **не видит**;
- прогрев дальних секций — по одной, только после паузы во взаимодействии (cooldown),
  с зазором между шагами;
- после свежего маунта settle стартует со следующего кадра (`requestAnimationFrame`),
  чтобы маунт не съел первые кадры анимации.

Реализация: `scheduleMountAdvance` в `app/(tabs)/settings/index.tsx` +
`lib/settingsMountedSections.ts` (юнит-тесты рядом).

## Методика: не гадать, а мерить

Все замеры — с подключённым устройством, без участия пользователя. Пакеты:
`social.flora.mobile.dev` (dev, scheme `flora-dev://`), `social.flora.mobile`
(release, scheme `flora://`).

```powershell
# 1. Открыть нужный экран
adb shell am start -W -a android.intent.action.VIEW -d "flora-dev://settings" social.flora.mobile.dev

# 2. Проверить, что открылось то (PowerShell портит бинарный редирект — только через файл!)
adb shell screencap -p /sdcard/x.png; adb pull /sdcard/x.png .\x.png; adb shell rm /sdcard/x.png

# 3. Статистика кадров: reset → жесты → framestats
adb shell dumpsys gfxinfo social.flora.mobile.dev reset
adb shell input swipe 900 1200 180 1200 250   # горизонтальный свайп ~250 мс
adb shell dumpsys gfxinfo social.flora.mobile.dev framestats > gfx.txt

# 4. Что именно тормозит: atrace (dev-сборка трассируема)
adb shell atrace --async_start -b 32768 -a social.flora.mobile.dev gfx view input
#   ...жесты...
adb shell atrace --async_stop -o /data/local/tmp/fl.trace
adb pull /data/local/tmp/fl.trace .\fl.trace
node Apps/Mobile/tools/parse-atrace.mjs .\fl.trace <pid>
```

Чтение `framestats` (CSV после `---PROFILEDATA---`): большой разрыв
`HandleInputStart → AnimationStart` = дорогая обработка input на UI-потоке (worklet'ы,
синхронные коммиты); большой `AnimationStart → PerformTraversalsStart` = маунт/коммит
React между стадиями. `FrameInterval` покажет реальную частоту (8.3 мс = 120 Гц).

Маркеры-симптомы в atrace:

| Маркер внутри MOVE | Диагноз |
|---|---|
| `UPDATE_STATE` + `ReactTextViewManager.updateState` | анимируется текстовый prop (color и т.п.) — коммит на каждый move |
| неразмеченные ~8 мс перед `MountItemDispatcher` | C++-часть того же коммита (клон, перемер, диф) |
| `draw-VRI[PopupWindow:...]`, `copySurfaceInto` | лупа выделения EditText под пальцем |
| connect/…/disconnect BufferQueue в `View#onTouchEvent` | создание/снос Surface лупы |

Дифференциальный приём: повторить тот же свайп по зоне без подозрительных вью
(например, по заголовкам вместо полей ввода) — если MOVE подешевел, виновник найден.

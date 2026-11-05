# Mobile: мгновенное переключение темы с кроссфейдом

План и журнал исполнения. Область — `apps/Mobile` (тема оформления в настройках).

## 1. Диагноз текущего механизма

Сейчас переключение темы — не переключение, а конвейер вокруг `react-native-view-shot`:

1. Тап кладёт тему в `pendingThemeId`; палитра **не меняется**.
2. `FloraThemeProvider` (≈600 строк) гонит 5 фаз: `capturing` → `covering` → `revealing` → `fading`.
   Снимок пишется в JPEG-файл на диск, читается и декодируется `expo-image`, ждём `onDisplay`.
3. Только после показа снимка применяется палитра, затем 2 rAF, затем fade 180 мс.
4. Чтобы спрятать задержку п. 2, на `onPressIn` делается prefetch-снимок с TTL 5 с и своим таймером.
5. Вокруг этого — 3 таймаута (capture 400 мс, display 320 мс, TTL 5 с), 2 счётчика поколений,
   8 `useRef`, отдельный модуль `floraThemeSnapshot.ts` для ленивого линка нативки.

Итог: задержка тап → первый видимый кадр ≈ 300–600 мс (на медленном тапе её маскирует prefetch),
store содержит транзиентное состояние (`pendingThemeId`, `applyPendingTheme`) только ради машины
состояний провайдера, а сам механизм зависит от файловой системы для копии кадра в том же процессе.

## 2. Целевая архитектура

Кроссфейд между двумя состояниями UI возможен только когда оба состояния существуют в пикселях.
Рендерить дерево дважды нельзя, анимировать цвета каждого узла нельзя (Fabric: `color` текста —
перемер Paragraph на каждый кадр, см. `apps/Mobile/AGENTS.md`). Значит — снимок старого кадра
поверх нового, но **снимок должен быть нативным и жить в памяти**, а не на диске.

### 2.1 Нативный модуль `flora-theme-crossfade` (Android, Expo Module)

Как остальные `apps/Mobile/modules/flora-*` (Android-only, `requireOptionalNativeModule`).

| Метод | Поток | Семантика |
| --- | --- | --- |
| `freeze(): Promise<boolean>` | main | `PixelCopy` окна Activity → `Bitmap` в памяти (GPU-readback, единицы мс; API ≥ 26, иначе `view.draw`) → `ImageView` поверх `android.R.id.content` c alpha 1. `true` — снимок на экране. `false` — Activity нет, reduce motion (`TRANSITION_ANIMATION_SCALE == 0`, как RN `AccessibilityInfo`) или ошибка: JS меняет тему мгновенно. Идемпотентен: повторный `freeze` при непрозрачном снимке — `true` без пересъёмки; во время fade — пересъёмка экрана **вместе с полупрозрачным снимком** (точное продолжение картинки). |
| `reveal(durationMs)` | JS → main | Дождаться кадра, в котором Fabric уже отрисовал новое дерево под снимком (`OnDrawListener` + `content.invalidate()`, страховка 120 мс) → `alpha 1→0` за `durationMs` по симметричной `PathInterpolator(0.36, 0, 0.64, 1)` (`--flora-ease-in`) → удалить. `durationMs ≤ 0` — убрать без анимации. Во время fade — no-op. |
| `cancel()` | JS → main | Убрать снимок немедленно (размонтирование провайдера, dev reload). |

Watchdog 1500 мс: если JS не позвал `reveal` (ошибка, обрыв бандла) — снимок снимается сам.

### 2.2 Store — единственный владелец темы, синхронный

`lib/floraThemeStoreCore.ts`: `selectTheme`/`discardTheme` сразу меняют `previewThemeId`
(галочка в настройках реагирует на тап мгновенно) и, если эффективная тема отличается от
применённой, передают `applyEffective` в стратегию `transition: (apply) => void`, заданную при
создании store. Стратегия по умолчанию — вызвать сразу (тесты). `pendingThemeId` и
`applyPendingTheme` удаляются. `commitTheme` палитру не трогает.

### 2.3 Стратегия перехода `lib/floraThemeCrossfade.ts`

```ts
let freezing = false;              // пока снимок снимается, второй freeze не нужен
freeze().then((covering) => {
  freezing = false;
  const changed = apply();           // палитра + version+1 → синхронный флаш подписчиков
  if (covering && !changed) reveal(0); // выбор откатили, пока снимался кадр: коммита не будет
});
```

Повторный выбор во время съёмки кадра не запускает второй `freeze`: отложенный `apply` читает
актуальную тему из store. Иначе второй `freeze` отменял бы сессию первого, и палитра успевала
смениться без снимка — вспышка вместо кроссфейда.

Чистая функция от API модуля — тестируется в vitest без React Native.

### 2.4 Провайдер — ~40 строк

`FloraThemeProvider` даёт контекст `{ themeId, epoch }` и в `useLayoutEffect([version])` зовёт
`reveal(240)`: layout-эффекты детей уже отработали, новое дерево закоммичено. Passive-эффект
не подходит — шедулер откладывает его на сотни мс на тяжёлом дереве. На размонтирование — `cancel()`.

### 2.5 Таймлайн (Android)

```
tap ─► selectTheme: set({ previewThemeId })                      галочка — сразу
    ─► transition(applyEffective) ─► native.freeze()              main: PixelCopy ≈ 2–8 мс, overlay в дереве
    ◄─ true ─► applyEffective(): applyFloraTheme + set({ appliedThemeId, version+1 })
    ─► один синхронный коммит подписчиков ─► FloraThemeProvider.useLayoutEffect ─► native.reveal(240)
    main: invalidate → draw с новым деревом (~1 кадр) ─► alpha 1→0, 240 мс ─► remove
```

Единственная оставшаяся латентность — перерисовка активного экрана React'ом; её ограничивают уже
имеющиеся `enableFreeze(true)` + `useFloraThemeRefresh(isActive)`.

### 2.6 iOS

Модуль объявлен `platforms: ["android"]` (конвенция `modules/flora-*`), на iOS
`requireOptionalNativeModule` → `null` → тема переключается мгновенно без кроссфейда (как сейчас
без view-shot). Следующий шаг (не в этой задаче, с Windows не собрать и не проверить):
`ios/FloraThemeCrossfadeModule.swift` — `window.snapshotView(afterScreenUpdates: false)` в
`keyWindow`, `UIViewPropertyAnimator(duration:controlPoint1:(0.33,1) controlPoint2:(0.2,1))`,
ожидание двух `CADisplayLink`-тиков перед fade, тот же JS-контракт.

## 3. Изменения по файлам

Создать:

- `apps/Mobile/modules/flora-theme-crossfade/{package.json, expo-module.config.json, android/build.gradle}`
- `apps/Mobile/modules/flora-theme-crossfade/android/src/main/java/expo/modules/florathemecrossfade/FloraThemeCrossfadeModule.kt`
- `apps/Mobile/modules/flora-theme-crossfade/src/index.ts` — типизированный `requireOptionalNativeModule`
- `apps/Mobile/lib/floraThemeCrossfade.ts` — `THEME_CROSSFADE_MS`, `createFloraThemeTransition`
- `apps/Mobile/lib/floraThemeCrossfade.test.ts`

Переписать с нуля:

- `apps/Mobile/lib/FloraThemeProvider.tsx`
- `apps/Mobile/lib/floraThemeStoreCore.ts` + `floraThemeStoreCore.test.ts`
- `apps/Mobile/stores/themeStore.ts` — подключение стратегии, dev-предупреждение при отсутствии модуля

Править:

- `apps/Mobile/components/settings/CustomizationSettingsTab.tsx` — убрать `onPressIn`-prefetch и `useFloraThemeActions`
- `apps/Mobile/package.json` — `+ flora-theme-crossfade`, `− react-native-view-shot`; `package-lock.json` через `npm install`
- `apps/Mobile/AGENTS.md` — раздел «Темы» под новый механизм

Удалить:

- `apps/Mobile/lib/floraThemeSnapshot.ts`

Границы: всё внутри `apps/Mobile` (App shell), бизнес-логики нет, контракт модуля — три функции.

## 4. Проверка

- `npm run typecheck -w @flora/mobile`, `npm run lint -w @flora/mobile`, `npm run test -w @flora/mobile`.
- Kotlin: `apps/Mobile/android> .\gradlew :flora-theme-crossfade:compileDebugKotlin` (prebuild уже есть).
- На устройстве после пересборки dev-клиента (`npm run install:android:debug`): Настройки → Кастомизация:
  тап — галочка сразу, кроссфейд без вспышки; быстрый двойной тап по разным темам; уход из настроек
  без сохранения — обратный кроссфейд; «Отключить анимации» в системе — мгновенно; старый билд без
  модуля — мгновенно + предупреждение в dev.

## 5. Риски и решения

- Z-порядок: RN ставит `elevation` на View, `FrameLayout` рисует детей по Z → overlay `elevation = 1e6`,
  `outlineProvider = null` (без тени), не кликабелен — касания проходят к дереву.
- `PixelCopy` недоступен/ошибка (API 24–25, protected surface) → `view.draw(Canvas)`: SurfaceView/TextureView
  в этом пути чёрные; тема переключается из настроек, где их нет.
- Память: ARGB_8888 на весь экран (10–18 МБ) живёт ≤ 400 мс, ссылки отпускаются при удалении overlay
  (без ручного `recycle` — RenderThread может держать кадр).
- Тяжёлый экран: снимок остаётся непрозрачным до коммита — задержка, но не вспышка; watchdog 1500 мс.
- Старт fade по кадру, а не по числу кадров: на 120 Гц два кадра — ~16 мс, а mount Fabric на экране настроек
  может занять больше. Fade стартовал раньше новой палитры → переход читался как резкая подмена.
  `invalidate()` после `reveal` гарантирует, что ожидаемый draw наступит даже на статичном экране.

## 6. Журнал исполнения

Выполнено 2025-11-02.

1. **Нативный модуль** `apps/Mobile/modules/flora-theme-crossfade` — `package.json`,
   `expo-module.config.json` (`platforms: ["android"]`), `android/build.gradle`,
   `FloraThemeCrossfadeModule.kt` (`freeze` → `AsyncFunction` + `Promise` на `Queues.MAIN`;
   `reveal`/`cancel` → sync `Function` c переходом на main), `src/index.ts`
   (`requireOptionalNativeModule("FloraThemeCrossfade")`, на iOS — `null`).
   Autolinking видит модуль (`expo-modules-autolinking resolve -p android` → проект `:flora-theme-crossfade`).
   Kotlin собран: `.\gradlew :flora-theme-crossfade:compileDebugKotlin` (Kotlin 2.1.20, compileSdk 36, minSdk 24).
2. **JS**: `lib/floraThemeCrossfade.ts` (стратегия + `THEME_CROSSFADE_MS`), `lib/floraThemeStoreCore.ts`
   (синхронный store со стратегией `transition`, без `pendingThemeId`), `lib/FloraThemeProvider.tsx`
   (контекст + `reveal` из `useLayoutEffect([version])`, `cancel` на размонтирование; 60 строк вместо 590),
   `stores/themeStore.ts` (подключение стратегии, dev-предупреждение без модуля),
   `components/settings/CustomizationSettingsTab.tsx` (без `onPressIn`-prefetch и `useFloraThemeActions`).
3. **Удалено**: `lib/floraThemeSnapshot.ts`, зависимость `react-native-view-shot` (+5 транзитивных из lockfile),
   prefetch-снимки, таймауты capture/display/TTL, счётчики поколений.
4. **Тесты**: `lib/floraThemeStoreCore.test.ts` переписан (14 кейсов, включая отложенную стратегию:
   коалесценция быстрых тапов, откат до применения, commit/discard при незавершённом переходе);
   новый `lib/floraThemeCrossfade.test.ts` (7 кейсов: порядок, `reveal(0)` при неизменённой палитре,
   fallback при `freeze → false`/reject, без модуля).
5. **Проверки**: `tsc --noEmit` ✓; `vitest run` — 96 файлов / 1027 тестов ✓; `eslint` по изменённым файлам ✓
   (0 предупреждений); `npm install` обновил `package-lock.json`.
6. `apps/Mobile/AGENTS.md` → раздел «Темы» описывает новый механизм.

Осталось на стороне устройства: пересобрать dev-клиент (новый нативный модуль) —
`npm run install:android:debug` или `npx expo run:android` в `apps/Mobile`, затем ручной прогон п. 4.
Без пересборки тема переключается мгновенно без кроссфейда и пишет предупреждение в dev-консоль.
iOS — п. 2.6, отдельной задачей.

### 6.1 Исправление 2025-11-02: кроссфейд не был виден на устройстве

Симптом после пересборки dev-клиента: тема менялась резко, без растворения (модуль слинкован —
в dex есть регистрация в `ExpoModulesPackageList`, dev-предупреждение не писалось).

Причина: `reveal` ждал фиксированные 2 кадра `Choreographer`. На 120 Гц это ~16 мс, а mount
Fabric на тяжёлом экране настроек в них не укладывается: fade стартовал, когда под снимком
ещё была старая палитра, и к моменту отрисовки нового кадра анимация уже заканчивалась.

Исправлено:

1. `reveal` ждёт первый draw контента после `content.invalidate()` (`OnDrawListener` +
   страховочный таймаут 120 мс) — к этому кадру mount уже выполнен, потому что сообщение
   Fabric уходит на UI-поток раньше, чем JS зовёт `reveal` из layout-эффекта.
2. `showOverlay` дополнительно делает `bringToFront()`.
3. `createFloraThemeTransition` коалесцирует выборы, пока снимок снимается: второй `freeze`
   отменял сессию первого, и палитра успевала смениться без снимка.
4. Диагностика: debug-логи `FloraThemeCrossfade` (причина отказа `freeze`, время до кадра,
   длина fade) — `adb logcat -s FloraThemeCrossfade`.

Проверено: `:flora-theme-crossfade:compileDebugKotlin` ✓; `tsc --noEmit` ✓; `vitest run` —
96 файлов / 1028 тестов ✓; `eslint` по изменённым файлам ✓.

### 6.2 Исправление 2025-11-02: кроссфейд всё ещё читался как подмена

После 6.1 механизм отрабатывал (логи: `freeze: covered 1080x2340 in 28ms`,
`reveal: new frame in 8ms`), но визуально тема менялась резко. Запись экрана (`screenrecord`)
и покадровый `YAVG` показали: при 180 мс и `PathInterpolator(0.33, 1, 0.2, 1)` почти всё
изменение яркости приходилось на 2–3 кадра из ~21 — `ENERGETIC_OPEN_EASING` проектировался
для появления, а не для dissolve.

Исправлено:

1. Кривая `PathInterpolator(0.36, 0, 0.64, 1)` — `--flora-ease-in` (`ENERGETIC_CLOSE_EASING`),
   симметричная: 10/50/90% проходятся примерно за 24/50/76% длительности.
2. `THEME_CROSSFADE_MS` 180 → 240.

Проверено на устройстве (SM-S931B, 120 Гц): записи экрана выплавили ровную кривую
`YAVG` в обе стороны — изменение распределено на ~20 кадров, тусклых скачков нет;
три быстрых тапа подряд дают три корректных freeze/reveal без зависшего снимка.
`tsc --noEmit` ✓; `vitest run` 96 файлов / 1028 тестов ✓; `eslint` ✓;
`:app:installDebug` (arm64) ✓.

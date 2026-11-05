# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v56.0.0/ before writing any code.

## Плавность свайпов / пейджеры (Android, Fabric)

Полный разбор и методика замера — [`docs/android-swipe-performance.md`](docs/android-swipe-performance.md). Жёсткие правила:

- Per-frame анимации (от `scrollX` и т.п.) — только `transform`/`opacity`. **Не анимировать `color` текста** (на Fabric это UPDATE_STATE-коммит Paragraph с перемером текста на каждый touch-move) и layout-свойства (`width` и пр.). Кроссфейд цвета текста — два слоя текста + opacity.
- Скроллы и текстовые поля внутри пейджера — `ScrollView`/`TextInput` из **react-native-gesture-handler**, не из react-native: иначе при свайпе они не получают ACTION_CANCEL (EditText рисует лупу выделения — по 13–15 мс/кадр). Неактивным страницам — `overScrollMode="never"`; `nestedScrollEnabled` без нужды не включать.
- `removeClippedSubviews` не ставить на контейнер, едущий в `translateX`.
- Тяжёлые страницы не маунтить во время жеста/анимации (busy-guard; `InteractionManager` жесты RNGH/Reanimated не видит); прогрев — по одной в тишину. Эталоны: `app/(tabs)/settings/index.tsx`, `lib/useCollapsibleHeader.tsx`.
- Тормозит — **мерить, не гадать**: deep link + `input swipe` + `dumpsys gfxinfo` + atrace, парсер `tools/parse-atrace.mjs` (команды в доке).

## Social push dismiss

Tray dismiss for aggregated social notifications uses `@flora/client-core` `isSocialTrayPushData` / tags:

- Canonical FCM tags: `like`, `repost`, `follow` (one slot per recipient + activity kind).
- Legacy tags still dismissed: `like:{postUuid}`, `repost:{postUuid}`.
- Helpers: `dismissSocialPushNotifications`, `dismissPresentedSocialPushNotifications` in `lib/pushNotifications.ts`.

## Темы

- Палитры — `lib/floraTheme.ts` (`dark`, `light`, `flora`); единственный владелец темы — `stores/themeStore.ts` поверх `lib/floraThemeStoreCore.ts`: выбор (`previewThemeId`) меняется синхронно, палитру применяет стратегия `transition` (по умолчанию сразу; в приложении — кроссфейд). Контекст — `lib/FloraThemeProvider.tsx`, черновик для настроек — `lib/useFloraThemeDraft.ts`. Никакого `pendingThemeId`/отложенного состояния в store.
- Переход темы — нативный crossfade, модуль `modules/flora-theme-crossfade` (Android, как остальные `flora-*`). `freeze()` — `PixelCopy` окна в `Bitmap` в памяти + непрозрачный `ImageView` поверх `android.R.id.content` (elevation выше любого RN, без outline, касания проходят). Потом JS меняет палитру (`createFloraThemeTransition` в `lib/floraThemeCrossfade.ts`). После коммита `FloraThemeProvider` из `useLayoutEffect([version])` зовёт `reveal(THEME_CROSSFADE_MS)` — модуль ждёт **draw**, в котором Fabric уже отрисовал новое дерево (`OnDrawListener` + принудительный `invalidate()`, таймаут 120 мс), и растворяет снимок 240 мс по симметричной кривой `PathInterpolator(0.36, 0, 0.64, 1)` (`--flora-ease-in` = `ENERGETIC_CLOSE_EASING`). Считать кадры нельзя: на 120 Гц два кадра — ~16 мс, mount тяжёлого экрана в них не укладывается. И `ENERGETIC_OPEN_EASING` (0.33, 1, 0.2, 1) не подходит: он отдаёт ~90% за первые ~25% времени, и dissolve читался как подмена. Никаких файлов, декодирования, prefetch и таймеров на JS; watchdog 1500 мс — в модуле.
- Reveal — только из layout-эффекта провайдера после коммита (passive откладывается на сотни мс на тяжёлом дереве). Стратегия шлёт `reveal(0)` лишь когда палитра под снимком не изменилась (выбор откатили за время съёмки); на уже запланированном растворении это no-op. Пока `freeze` в полёте, повторные `transition` не запускают второй снимок: отложенный `apply` читает актуальный выбор store (иначе второй `freeze` отменял сессию первого и палитра успевала смениться без снимка).
- Без модуля (iOS, старый dev-build) и при reduce motion (`TRANSITION_ANIMATION_SCALE == 0`, как RN `AccessibilityInfo`) `freeze()` → `false`: тема применяется мгновенно. Повторный `freeze` во время fade снимает экран вместе с полупрозрачным снимком — быстрый двойной тап не даёт скачка.
- Смена темы не должна перерисовывать навигационную оболочку: `app/(tabs)/_layout.tsx` не подписывается на тему, фон даёт локальный `TabsThemedBackdrop`, цвета таб-бара — из подписок внутри иконок (`tabbar/TabBarNavIcons.tsx`) и `TabBarIconWithBadge`. В пейджере настроек подписка гейтится по `isActive` (`useFloraThemeRefresh`).
- `enableFreeze(true)` в `app/_layout.tsx`: `freezeOnBlur` у табов уже был, но без `enableFreeze` не работал — смена темы перерисовывала все смонтированные вкладки (~+40% к времени перехода).
- Новый цвет — токен палитры или `floraColors.overlay(a)`, не литерал. Стили с цветами — через `liveGridStyles`: кэш на `Map` по ключу «сетка + тема», не модульный `StyleSheet.create`.
- Экран и любой `memo`-компонент, читающий цвета, подписываются на тему: `useFloraTheme()`.
- Переходы темы и персист — `lib/floraThemeStoreCore.test.ts`, стратегия кроссфейда — `lib/floraThemeCrossfade.test.ts`, контраст палитр — `lib/floraTheme.test.ts`. Kotlin модуля: `apps/Mobile/android> .\gradlew :flora-theme-crossfade:compileDebugKotlin`. Диагностика перехода в debug-сборке: `adb logcat -s FloraThemeCrossfade` (решение `freeze`, время до кадра и длина fade). План и журнал — [`mobile-theme-crossfade.md`](../../mobile-theme-crossfade.md) в корне репо.

## Сетка и внесенка (sPx)
Ритм layout — `N × floraSpacing.grid` (15s) / `gridFine` (5s). Внесенка (кегль, иконки, радиусы, off-ladder) — `sPx(n)` / `kegl(n)` / `tracking(n)` из `@flora/design` через [`lib/floraGridRuntime.ts`](lib/floraGridRuntime.ts); SoT шаблонов — `@flora/design`. Unitless web line-height → `ratio * kegl(размерШрифта)`, не `sPx` от произведения. Hairline `1` / `0.5` не масштабировать. Не `export const x = sPx(49)` и не модульный `StyleSheet.create`, который зовёт `sPx`/`kegl`/`tracking` или читает live-токены — только `liveGridStyles` / `liveGridRecord` / create в рендере. Ionicons `size` — `useSPx()(n)` или уже живой токен.

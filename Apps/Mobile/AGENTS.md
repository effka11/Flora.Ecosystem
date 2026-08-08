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

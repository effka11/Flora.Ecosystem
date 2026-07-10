# Flora Mobile (Expo)

Клиент Flora Social для Android (dev-client) и iOS.

## Push / FCM (только release APK)

OS push (FCM) **не используется** в **Flora Dev** (`social.flora.mobile.dev`). В dev обновления идут через **SSE** (при открытом приложении) и **polling** бейджей.

Настройка push для production: `..\..\Scripts\setup-android-push.ps1`

### Release (`social.flora.mobile`)

1. [Firebase Console](https://console.firebase.google.com) → Android-приложение с package **`social.flora.mobile`**.
2. `google-services.json` → `Apps/Mobile/google-services.json`.
3. Service account на Flora.API → `Flora.API/secrets/` + `appsettings.Local.json` (см. `appsettings.Local.example.json`).
4. Сборка: `..\..\Scripts\mobile-release-android.ps1`

Push: новые DM (без текста E2E в payload).

## Уведомление о новой версии (Android release)

После публикации APK на GitHub Releases можно разослать in-app уведомление «Новая версия Android» всем пользователям release APK.

### Sideload auto-update (PackageInstaller)

Production APK (`social.flora.mobile`, `extra.sideloadUpdates`) умеет тихо обновляться с GitHub Releases:

1. После логина показывается Flora-модалка разрешения «установка неизвестных приложений», затем открывается Settings. `Back` и «Нет, спасибо» считаются постоянным отказом и навсегда отключают повторный показ.
2. Если разрешение есть и Android 12+: приложение проверяет `flora.social-android-update.json` на последнем релизе `social/v*`, при необходимости скачивает APK (resumable) и ставит через PackageInstaller без UI.
3. Если silent невозможен (нет permission / Android < 12 / OEM) — **единственный** UI-вход: кнопка «Обновить» в уведомлении `app_update`.

Sideload updater: native module линкуется в **Dev** (чтобы проверить диалог разрешения) и в production sideload APK. Silent GitHub-update только при `extra.sideloadUpdates` (release APK).

EAS `production` (Play AAB) задаёт `FLORA_DISABLE_SIDELOAD_UPDATES=1`:
- plugin и `REQUEST_INSTALL_PACKAGES` не добавляются;
- `flora-apk-updater` исключается из Android autolinking;
- в `extra.playStoreBuild` пишется `true` — модалка разрешения установки и PackageInstaller-path **не включаются** даже если модуль когда-то попадёт в бинарь.

Локальная AAB-сборка (`FLORA_ANDROID_BUILD_AAB=1`) автоматически включает тот же Play-режим. Один запуск не публикует такую APK в GitHub: `-PublishGitHub` разрешён только для sideload-режима.

Публикация релиза:

```powershell
# тег social/v<version> уже на remote
.\Scripts\mobile-release-android.ps1 -PublishGitHub
# рекомендуется сразу уведомить пользователей без silent-path:
.\Scripts\send-apk-auto-update.ps1 -Production -Confirm
```

Манифест рядом с APK: `flora.social-android-update.json` (`versionCode`, `sha256`, `sizeBytes`, `apkUrl`). Для старых релизов кнопка использует SHA-256 и размер из GitHub asset metadata, но не silent-update. Один pending-файл в `cache/flora-update/pending.apk`.

Smoke: установить APK с updater (vN) → опубликовать vN+1 с большим `versionCode` → после логина и разрешения должна пройти тихая установка; без разрешения — только кнопка в уведомлении.

### Один раз на сервере

На VPS в `/etc/flora-ecosystem/flora-api.env`:

```bash
Flora__AdminBroadcastToken=<длинный случайный секрет>
```

Тот же секрет локально в `Scripts/broadcast.env` (скопировать из `Scripts/broadcast.env.example`). При генерации prod-конфига:

```powershell
.\Scripts\generate-prod-local-config.ps1 -ServerHost flora-s.net
```

создаёт `appsettings.Production.json` и `Scripts/broadcast.env` с одним токеном — значение нужно перенести на VPS и перезапустить `flora-api`.

### Перед каждым релизом

```powershell
.\Scripts\setup-app-update-broadcast.ps1    # проверка токена и API
# 1. сборка APK, 2. GitHub release, 3. deploy API при необходимости
.\Scripts\send-apk-auto-update.ps1 -Production -Confirm
```

Опционально сразу после сборки: `.\Scripts\mobile-release-android.ps1 -PublishGitHub -BroadcastUpdate` (broadcast — fallback UX, если silent не сработал).

## Локальная разработка

Metro dev-client **всегда** ходит на `http://localhost:5284` (локальный Flora.API). JS-бандл приходит с Metro (`:8081`).

```bash
npm install   # из корня monorepo
# VS Code: Flora Android: debug (USB)  или  ../../Scripts/mobile-debug-android.ps1
```

**Flora Dev** (`social.flora.mobile.dev`) — отдельное приложение, prod APK **Flora** (`social.flora.mobile`) не затрагивается.

Переустановка dev-client: `../../Scripts/mobile-install-debug-android.ps1 -ReplaceExisting`

`.env` → `EXPO_PUBLIC_API_URL` используется **только** при release-сборке APK/AAB.

## Production APK

См. [`Scripts/mobile-release-android.ps1`](../../Scripts/mobile-release-android.ps1). Требуется `Apps/Mobile/.env` с `EXPO_PUBLIC_API_URL`.

# Flora Mobile (Expo)

Клиент Flora Social для Android (dev-client) и iOS.

## Push / secure message preview

OS push (FCM) **не используется** в **Flora Dev** (`social.flora.mobile.dev`). В dev обновления идут через **SSE** (при открытом приложении) и **polling** бейджей.

Настройка push для production: `..\..\Scripts\setup-android-push.ps1`

### Release (`social.flora.mobile`)

1. [Firebase Console](https://console.firebase.google.com) → Android-приложение с package **`social.flora.mobile`**.
2. `google-services.json` → `Apps/Mobile/google-services.json`.
3. Service account на Flora.API → `Flora.API/secrets/` + `appsettings.Local.json` (см. `appsettings.Local.example.json`).
4. Сборка: `..\..\Scripts\mobile-release-android.ps1`

Новые DM используют per-installation `NotificationPreviewEnvelope`: Android получает
data-only FCM и расшифровывает до показа, iOS получает generic APNs alert с
`mutable-content` и расшифровывает его в `FloraSecurePushNSE`. FCM/APNs не получают
plaintext. При ошибке/opt-out показывается «Новое сообщение».

### iOS APNs / NSE

1. На macOS выполнить `Scripts/build-fscp-mobile-ios.sh`; EAS запускает его через
   `eas-build-post-install` и создаёт device+simulator XCFramework.
2. Первый production build выполнить интерактивно: `eas build --platform ios
   --profile production`, подтвердить provisioning для host и
   `social.flora.mobile.SecurePushNSE`, App Group и Keychain group.
3. В backend задать `Push__Apns__TeamId`, `Push__Apns__KeyId`,
   `Push__Apns__Topic=social.flora.mobile` и secret `Push__Apns__PrivateKey`
   (APNs `.p8`, с переводами строк). Для sandbox также
   `Push__Apns__Sandbox=true`.
4. `eas.json`/`app.config.ts` объявляют extension для EAS credentials. Private
   APNs key и provisioning-файлы в git не добавлять.

## Уведомление о новой версии (Android release)

После публикации APK на канал Flora (`social.flora-s.net/apk`) можно разослать in-app уведомление «Новая версия Android» всем пользователям release APK.

### Sideload auto-update (PackageInstaller)

Production APK (`social.flora.mobile`, `extra.sideloadUpdates`) обновляется **только с канала Flora** (`https://social.flora-s.net/apk/`) через FCM + native `UpdateCoordinator`. GitHub Releases не используется для скачивания APK.

Один `InstallPermissionHost` в `FloraProviders` (sideload only) — sheet для OS `REQUEST_INSTALL_PACKAGES`.

#### Настройки → Уведомления (два ползунка)

1. **«Установка обновлений»** (`apkUpdate.inAppUpdatesEnabled`, default OFF) — opt-in на in-app PackageInstaller и prerequisite для фона. Включение → sheet + OS permission. Выключение → принудительно OFF фонового. **Не** блокирует кнопку inbox: тап «Обновить» сам запрашивает OS и может включить этот pref.
2. **«Фоновое обновление»** (`apkUpdate.autoUpdateEnabled`) — native write-through. Switch disabled/серый без первого ползунка или без OS permission. Включить только при inApp ON + `canRequestPackageInstalls()`.

Подписи: установка — «Нужно для установки из приложения и для фонового обновления.»; фон — «Скачивание с канала Flora в фоне; установка при свёрнутом приложении (Android 12+).»

#### Путь 1.1 — фон (opt-in)

1. Оба ползунка ON + OS permission.
2. Task `Send auto-update & notifications to side-APK` → inbox + **data-only HIGH FCM** (`type=app_update` + flat `version,versionCode,apkUrl,sha256,…` на канал `/apk/`). Без ключа `notification` и без системного tray «новая версия».
3. Native: DownloadManager с channel URL → SHA-256 → `READY`. Silent install (`USER_ACTION_NOT_REQUIRED`) только если процесс **не в foreground ≥ 10 с** (WorkManager delay). Возврат в UI отменяет отложенный install.
4. Скачивание в foreground разрешено; установка в foreground — **нет** (кроме кнопки).
5. Android &lt; 12 или OEM без silent → `READY` + local «готово»; установка через кнопку.
6. **Catch-up** при login / AppState active / включении фона: latest канала через `fetchLatestUpdateManifest` (`flora.social-android-update.json`, иначе первый entry в `releases.json`); stale READY (VC ≤ installed) чистится; иначе unread inbox `app_update`. Throttle **15 мин** (`apkUpdate.catchUpAt`). Пропуск throttle: phase `FAILED`; один retry после cleanup stale READY при latest VC > installed; **`force` при включении ползунка «Фоновое обновление»** (иначе свежий foreground catch-up мог бы проглотить opt-in).

#### Путь 2.x — кнопка «Обновить» в inbox

| | Условие | Поведение |
|--|---------|-----------|
| perm | нет OS permission | Flora-sheet; grant → `inAppUpdatesEnabled=true` + 2.1/2.2; decline → 2.4 |
| 2.1 | permission + APK `READY` той же версии | только install (в foreground OK); pref inApp ON |
| 2.2 | permission, APK ещё нет | download с канала + interactive install; pref inApp ON |
| wait | native `DOWNLOADING` той же VC | ждать READY → 2.1 (без второго DownloadManager) |
| 2.4 | decline / нет OS perm после sheet / нет native / CHANNEL | прямое скачивание APK с канала Flora |
| err | DOWNLOAD / INSTALL / SHA256 после retry | ошибка в UI (без авто-2.4); SHA → clear pending + повторная 2.2 загрузка |

#### Сборки

Sideload updater линкуется в **Dev** и production sideload APK. Два Switch и silent-путь только при `extra.sideloadUpdates`.

EAS `production` (Play AAB) / `FLORA_DISABLE_SIDELOAD_UPDATES=1`: без permissions, без модуля, без PackageInstaller (кнопка → `/download`).

#### Публикация

```powershell
# One-shot on VPS if needed: Apps/Web/scripts/patch-nginx-apk-channel.sh
.\Scripts\mobile-release-android.ps1 -PublishChannel
.\Scripts\send-apk-auto-update.ps1 -Production -Confirm
```

Скрипт broadcast подхватывает `Apps/Mobile/dist/flora.social-android-update.json` (или latest с `/apk/flora.social-android-update.json`) и шлёт поле `update` в API (`apkUrl` на `social.flora-s.net/apk/…`).

Манифест локально: `Apps/Mobile/dist/flora.social-android-update.json` (`versionCode`, `sha256`, `sizeBytes`, `apkUrl`) — SoT для broadcast/`update{}` в FCM. На канал кладутся APK + latest update.json + `releases.json`. Pending APK: `flora-update/pending.apk` в app external-files.

Fallback 2.4 открывает прямую ссылку на APK версии из текста уведомления (`https://social.flora-s.net/apk/flora.social-v{version}-android.apk`), не HTML-страницу. Кнопка «Обновить» для установки предпочитает **channel latest** (если VC ≥ версии из inbox), затем native READY sha256.

#### Smoke

1. Оба ползунка OFF → broadcast → только inbox, нет download / catch-up.
2. «Установка» ON без permission → sheet → отказ → ползунок OFF; «Фон» серый/disabled.
3. Оба ON + permission, app killed → broadcast → download с `/apk/` → silent install ≥3 s вне UI (Worker откладывает, не отменяет при кратком возврате в UI).
4. Фон ON + foreground → download, install нет → свернуть ≥10 s → install.
5. Свернуть &lt;10 s и вернуться → install не произошёл.
6. DOWNLOADING + кнопка той же VC → ждёт READY → 2.1.
7. READY → кнопка → 2.1; нет файла → 2.2 с channel URL.
8. Revoke install perm при ON → auto skip; meta + «Выдать разрешение»; кнопка → Flora-sheet → grant → 2.1/2.2, decline → 2.4 channel APK.
9. APK на канале новее, уведомление не слали, фон ON → catch-up (≤15 мин) скачивает latest.
10. Regression: обычный DM FCM после wrapper FMS всё ещё доставляет.
11. Logcat: `startAuto` не пишет `APK URL not allowlisted` для `social.flora-s.net/apk/…`.

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
# 1. сборка APK, 2. -PublishChannel, 3. deploy API при необходимости
.\Scripts\send-apk-auto-update.ps1 -Production -Confirm
```

Опционально сразу после сборки: `.\Scripts\mobile-release-android.ps1 -PublishChannel -BroadcastUpdate` (broadcast — fallback UX, если silent не сработал).

## Локальная разработка

Metro dev-client **всегда** ходит на `http://localhost:5290` (`flora-api`). JS-бандл приходит с Metro (`:8081`). USB: `adb reverse tcp:5290 tcp:5290`.

```bash
npm install   # из корня monorepo
# VS Code: Flora Android: debug (USB)  или  ../../Scripts/mobile-debug-android.ps1
```

**Flora Dev** (`social.flora.mobile.dev`) — отдельное приложение, prod APK **Flora** (`social.flora.mobile`) не затрагивается.

Переустановка dev-client: `../../Scripts/mobile-install-debug-android.ps1 -ReplaceExisting`

`.env` → `EXPO_PUBLIC_API_URL` используется **только** при release-сборке APK/AAB.

## Production APK

См. [`Scripts/mobile-release-android.ps1`](../../Scripts/mobile-release-android.ps1). Требуется `Apps/Mobile/.env` с `EXPO_PUBLIC_API_URL`.

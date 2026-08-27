# Flora Mobile (Expo)

Клиент Flora Social для Android (dev-client) и iOS.

## Push / secure message preview

OS push (FCM) **не используется** в **Flora Dev** (`social.flora.mobile.dev`). В dev обновления идут через **SSE** (при открытом приложении) и **polling** бейджей.

Настройка push для production: `..\..\Scripts\setup-android-push.ps1`

### Production API (Cloudflare)

Release APK ходит на **`https://social.flora-s.net`** (оранжевый Cloudflare). Серый `origin.*` в клиент не зашивается: из сетей, где CF недоступен, Flora не должна открываться. `EXPO_PUBLIC_GOV_URL=https://gov.flora-s.net` зашит заранее: civic-шелл на том же CDN; процесс Next на `:3001` — отдельный деплой.

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

#### Настройки → Обновления (`UpdatesSettingsTab`)

1. **«Установка обновлений»** — **зеркало** live OS `REQUEST_INSTALL_PACKAGES` (`Switch.value = canRequestPackageInstalls()` после reconcile; MMKV `apkUpdate.inAppUpdatesEnabled` синхронизируется с OS в обе стороны). **ON** без perm → Flora-sheet → Settings; grant → ON; отказ → OFF + meta «Разрешение не выдано». **OFF** при выданном perm → та же системная страница (`openInstallPermissionSettings` / `ACTION_MANAGE_UNKNOWN_APP_SOURCES`); пользователь снимает разрешение; по возврату sync. Если не снял — тумблер остаётся ON. Снятие OS → фон тоже OFF. API &lt; 26: perm всегда true; OFF — immediate no-op (Settings не открывается, wait не стартует), тумблер остаётся ON. Нужна сборка с актуальным `flora-apk-updater` (`openInstallPermissionSettings` → boolean opened).
2. **«Фоновое обновление»** (`apkUpdate.autoUpdateEnabled`) — отдельный opt-in поверх OS. Switch disabled/серый без OS permission. Включить только при `canRequestPackageInstalls()`.
3. **«Проверить обновления» / «Обновить»** — ручная проверка канала (`runUserUpdateCheck`); кнопка в inbox `app_update` остаётся основным CTA по событию.

**Sync с OS:** при каждом `AppState` active / bootstrap `reconcileInstallPermissionWithOs()` — `hasOs` ⇔ inApp; `!hasOs` → auto OFF. Внешний grant/revoke OS (вне Flora) тоже двигает тумблер установки; после внешнего grant «Фон» становится enableable (не auto-ON).

Подписи: установка — «Нужно для установки из приложения и для фонового обновления.»; фон — «Скачивание с канала Flora в фоне; установка при свёрнутом приложении (Android 12+).»

#### Путь 1.1 — фон (opt-in)

1. Оба ползунка ON + OS permission.
2. Task `Send auto-update & notifications to side-APK` → inbox + **data-only HIGH FCM** (`type=app_update` + flat `version,versionCode,apkUrl,sha256,…` на канал `/apk/`). Без ключа `notification` и без системного tray «новая версия».
3. Native: DownloadManager с channel URL → **SHA-256 must match channel** (fail-closed; no hash adoption) → `READY`. Incomplete = `length < sizeBytes` when size known. Silent install (`USER_ACTION_NOT_REQUIRED`) планируется с задержкой **≥3 с**; Worker ставит только вне UI (краткий возврат в UI не отменяет уже запланированный work). Native `downloadFile` / install paths: URL allowlist + `flora-update/` sandbox.
4. Скачивание в foreground разрешено; установка в foreground — **нет** (кроме кнопки).
5. Android &lt; 12 или OEM без silent → `READY` + local «готово»; установка через кнопку.
6. **Catch-up** при login / AppState active / включении фона (после reconcile): latest канала через `fetchLatestUpdateManifest` (`flora.social-android-update.json`, иначе первый entry в `releases.json`); stale READY (VC ≤ installed) чистится; иначе unread inbox `app_update`. Throttle **15 мин** (`apkUpdate.catchUpAt`). Пропуск throttle: phase `FAILED`; один retry после cleanup stale READY при latest VC > installed; **`force` при включении ползунка «Фоновое обновление»**.

#### Путь 2.x — кнопка «Обновить» в inbox

| | Условие | Поведение |
|--|---------|-----------|
| perm | нет OS permission | Flora-sheet (без progress-card); grant → reconcile (inApp=OS) + 2.1/2.2; decline / возврат без perm → **ошибка** `NO_PERMISSION` |
| 2.1 | permission + APK `READY` той же версии | install-only; JS re-hash vs **channel** sha (не native rewrite) |
| 2.2 | permission, APK ещё нет | download с канала + interactive install; channel sha binding |
| wait | native `DOWNLOADING` той же VC | ждать READY → 2.1 (без второго DownloadManager) |
| 2.4 | нет native / нет манифеста / CHANNEL | прямое скачивание APK с канала Flora (не для отказа от perm) |
| err | NO_PERMISSION / DOWNLOAD / INSTALL / SHA256 | ошибка в UI (Закрыть; повтор — снова «Обновить») |

#### Сборки

Sideload updater линкуется в **Dev** и production sideload APK. Switch’и установки/фона и silent-путь только при `extra.sideloadUpdates` (вкладка **Обновления**).

EAS `production` (Play AAB) / `FLORA_DISABLE_SIDELOAD_UPDATES=1`: без permissions, без модуля, без PackageInstaller (кнопка → `/download`).

#### Публикация

```powershell
# One-shot on VPS if needed: Apps/Web/scripts/patch-nginx-apk-channel.sh
.\Scripts\mobile-release-android.ps1 -PublishChannel
.\Scripts\send-apk-auto-update.ps1 -Production -Confirm
```

Скрипт broadcast подхватывает `Apps/Mobile/dist/flora.social-android-update.json` (или latest с `/apk/flora.social-android-update.json`) и шлёт поле `update` в API (`apkUrl` на `social.flora-s.net/apk/…`).

Манифест локально: `Apps/Mobile/dist/flora.social-android-update.json` (`versionCode`, `sha256`, `sizeBytes`, `apkUrl`) — SoT для broadcast/`update{}` в FCM. `apkUrl` — зеркало `flora.social-v…-android-{sha8}.apk` (allowlist 0.12). На канал также кладётся канонический `flora-v{version}.apk` (`releases.json` / `/download`) и plain `flora.social-v…-android.apk` (fallback 2.4 старых клиентов). Pending APK: `flora-update/pending.apk` в app external-files.

Fallback 2.4 открывает прямую ссылку на APK версии из текста уведомления (`https://social.flora-s.net/apk/flora-v{version}.apk`), не HTML-страницу. Кнопка «Обновить» для установки предпочитает **channel latest** (если VC ≥ версии из inbox), затем native READY sha256.

#### Smoke

1. Оба ползунка OFF → broadcast → только inbox, нет download / catch-up.
2. «Установка» ON без permission → sheet → отказ → ползунок OFF + «Разрешение не выдано»; «Фон» серый/disabled.
3. «Установка» OFF при ON → открывается системная страница unknown-sources; не снял → тумблер ON; снял → OFF + фон OFF. Долгий уход (>90s timeout) → sync по return/timeout (обычно остаётся ON если не снял).
4. Оба ON + permission, app killed → broadcast → download с `/apk/` → silent install ≥3 s вне UI (Worker откладывает, не отменяет при кратком возврате в UI).
5. Фон ON + foreground → download → свернуть ≥3 s → install.
6. DOWNLOADING + кнопка той же VC → ждёт READY → 2.1.
7. READY → кнопка → 2.1; нет файла → 2.2 с channel URL.
8. Revoke install perm снаружи при ON → вернуться в Flora → тумблер+auto OFF.
9. Внешний grant OS без Flora → при следующем active тумблер установки ON; «Фон» enableable (остаётся OFF пока не включить).
10. «Обновить» без perm → только sheet → deny → error NO_PERMISSION (не браузер); grant → progress + install.
11. APK на канале новее, уведомление не слали, фон ON → catch-up (≤15 мин) скачивает latest.
12. Regression: обычный DM FCM после wrapper FMS всё ещё доставляет.
13. Logcat: `startAuto` не пишет `APK URL not allowlisted` для `social.flora-s.net/apk/…`.
14. Smoke OFF→Settings требует APK со свежим `flora-apk-updater` (`openInstallPermissionSettings`).
15. Channel sha ≠ file → native FAIL (не READY); кнопка «Обновить» → SHA256 / re-download. Republish того же VC обязан обновить `sha256`; catch-up/FCM идут на sha8-зеркало, канонический `flora-v{version}.apk` при той же версии требует purge CDN.
16. Integrity: channel SHA binding; size только incomplete (`length < sizeBytes`); без hash-adoption.

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

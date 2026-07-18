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

Production APK (`social.flora.mobile`, `extra.sideloadUpdates`) обновляется с GitHub Releases через FCM + native `UpdateCoordinator`.

#### Путь 1.1 — авто (opt-in)

1. После логина — Flora-модалка «установка из этого источника». `Back` / «Нет, спасибо» глушат повтор модалки; opt-in = факт `canRequestPackageInstalls()`.
2. `Send auto-update` → inbox + **data-only HIGH FCM** (`type=app_update`, поля `version` / `versionCode` / `apkUrl` / `sha256` / …). Без ключа `notification`, чтобы payload доходил при убитом процессе.
3. Native: tray (NotificationCompat) + DownloadManager → SHA-256 → `READY`. Silent install (`USER_ACTION_NOT_REQUIRED`) только если процесс **не в foreground ≥ 10 с** (WorkManager delay). Возврат в UI отменяет отложенный install.
4. Скачивание в foreground разрешено; установка в foreground — **нет** (кроме кнопки).
5. Android &lt; 12 или OEM без silent → `READY` + local «готово»; установка через кнопку.
6. Catch-up при open: unread `app_update` → direct `flora.social-android-update.json` → native download.

#### Путь 2.x — кнопка «Обновить» в inbox

| | Условие | Поведение |
|--|---------|-----------|
| 2.1 | permission + APK `READY` той же версии | только install (в foreground OK) |
| 2.2 | permission, APK ещё нет | download + interactive install |
| 2.3 | нет permission | download + system confirm; Settings один раз при необходимости; без Flora auto-modal |
| 2.4 | сбой / нет native | страница GitHub release |

#### Сборки

Sideload updater линкуется в **Dev** и production sideload APK. Авто-путь только при `extra.sideloadUpdates`.

EAS `production` (Play AAB) / `FLORA_DISABLE_SIDELOAD_UPDATES=1`: без permissions, без модуля, без PackageInstaller (кнопка → GitHub).

#### Публикация

```powershell
.\Scripts\mobile-release-android.ps1 -PublishGitHub
.\Scripts\send-apk-auto-update.ps1 -Production -Confirm
```

Скрипт broadcast подхватывает `Apps/Mobile/dist/flora.social-android-update.json` (или `gh release download`) и шлёт поле `update` в API.

Манифест: `flora.social-android-update.json` (`versionCode`, `sha256`, `sizeBytes`, `apkUrl`). Pending APK: `flora-update/pending.apk` в app external-files.

#### Smoke

1. Opt-in + app killed → broadcast → download → install без открытия UI (≥10 s вне foreground).
2. Opt-in + foreground → download, install нет → свернуть ≥10 s → install.
3. Свернуть &lt;10 s и вернуться → install не произошёл.
4. READY → кнопка → 2.1 только install.
5. Нет файла → кнопка → 2.2.
6. Decline permission → кнопка → 2.3 / GitHub.
7. Regression: обычный DM FCM после wrapper FMS всё ещё доставляет.

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

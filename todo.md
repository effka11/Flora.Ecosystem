# Flora — TODO

## Sideload APK auto-update

Реализовано (см. `Apps/Mobile/README.md` § Sideload auto-update):

- Broadcast `app_update` шлёт data-only HIGH FCM + inbox/SSE
- Native `UpdateCoordinator`: DownloadManager → SHA-256 → WorkManager 10s foreground gate → silent PackageInstaller
- Кнопка «Обновить»: 2.1 install-only / 2.2 download+install / 2.3 interactive / 2.4 GitHub

Ограничения (ожидаемые): OEM battery (Xiaomi и т.п.) может задерживать FCM; API &lt; 31 — только READY + кнопка; Play AAB без sideload-модуля.

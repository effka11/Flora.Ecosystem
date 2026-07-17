# Flora — TODO

## Настоящий фоновый APK-апдейт (sideload)

Цель: обновление без обязательного открытия UI — пуш будит устройство → скачивание → PackageInstaller.

- [ ] Broadcast `app_update`: не `skip_push` (или отдельный FCM data payload с version / apk URL)
- [ ] Клиент: обработчик background / cold-start FCM → silent check+install
- [ ] Фоновая работа (WorkManager / Expo background): download + SHA-256 + install session (foreground service при необходимости)
- [ ] Новый sideload APK + GitHub release с `flora.social-android-update.json`
- [ ] Проверка: приложение убито → push → APK ставится (или системный confirm на OEM)

Ограничения: нужен install-permission; Play/AAB не в скоупе; полный «тихий ночной» апдейт на неrooted Android не гарантируется.

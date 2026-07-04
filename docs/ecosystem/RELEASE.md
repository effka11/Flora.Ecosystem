# Релиз Flora.Ecosystem

Источник версий — [`VERSION`](../../VERSION). Синхронизация — `npm run version:sync` ([`Scripts/sync-version.mjs`](../../Scripts/sync-version.mjs)).

## Коммит-релиз

1. Обновить `VERSION` (`ecosystem` и `products.social` — одна semver-строка на релиз).
2. `npm run version:sync` — обновит `package.json`, `app.json`, `Directory.Build.props`, `Flora.API/flora-versions.json`.
3. Вручную:
   - `Apps/Mobile/app.json` — увеличить `expo.android.versionCode` на 1;
   - fallback-версии в `Apps/Mobile/lib/api.ts`, `avatarUpload.ts`, `communityAvatarUpload.ts`, `Apps/Web/lib/fscp/clientCore.ts`, `Apps/Web/next.config.ts`;
   - `README.md` — имя APK `flora.social-v<version>-android.apk`.
4. Коммит (GPG): `chore(ecosystem): v<version> release`.

Теги:

```powershell
git tag -s ecosystem/v<version> -m "Flora.Ecosystem v<version>"
git tag -s social/v<version> -m "Flora Social v<version>"
```

## Перед релизом

```powershell
dotnet build Flora.Ecosystem.slnx
dotnet test tests/Flora.ContractFixtures
npm run ci
```

В коммит не включать: `obj/`, `bin/`, `.env`, `secrets/`, `google-services.json`, `Scripts/broadcast.env`.

## После коммита

```powershell
# Web + API
cd Apps/Web; .\scripts\deploy.ps1

# Android APK → Apps/Mobile/dist/flora.social-v<version>-android.apk
.\Scripts\mobile-release-android.ps1
```

GitHub Release: тег `social/v<version>`, APK во вложениях.

Опционально — in-app уведомление о версии (после публикации APK):

```powershell
.\Scripts\setup-app-update-broadcast.ps1
.\Scripts\broadcast-app-update.ps1 -Production -Confirm
```

Подробности broadcast — [`Apps/Mobile/README.md`](../../Apps/Mobile/README.md).

## Чеклист

- [ ] `VERSION` — `ecosystem` и `products.social`
- [ ] `npm run version:sync`
- [ ] `Apps/Mobile/app.json` — `versionCode` +1
- [ ] Fallback-версии (Mobile: `api.ts`, `avatarUpload.ts`, `communityAvatarUpload.ts`; Web: `clientCore.ts`, `next.config.ts`)
- [ ] `README.md` — имя APK
- [ ] `dotnet build Flora.Ecosystem.slnx`
- [ ] `dotnet test tests/Flora.ContractFixtures`
- [ ] `npm run ci`
- [ ] `git commit -S` — `chore(ecosystem): v<version> release`
- [ ] Теги `ecosystem/v<version>`, `social/v<version>`
- [ ] `Apps/Web/scripts/deploy.ps1`
- [ ] `Scripts/mobile-release-android.ps1`
- [ ] GitHub Release + APK
- [ ] `broadcast-app-update.ps1` (опционально)

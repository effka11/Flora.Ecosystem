# Релиз Flora.Ecosystem

Источник версий — [`VERSION`](../../VERSION). Синхронизация — `npm run version:sync` ([`Scripts/sync-version.mjs`](../../Scripts/sync-version.mjs)).

## Коммит-релиз

1. Обновить `VERSION` (`ecosystem` и `products.social` — одна semver-строка на релиз).
2. `npm run version:sync` — обновит `Apps/*/package.json`, `Apps/Mobile/app.json`, `Packages/flora-client-core`, `Backend/flora-versions.json`, `Cargo.toml` (`# synced-from-VERSION`).
3. Вручную:
   - `Apps/Mobile/app.json` — увеличить `expo.android.versionCode` на 1;
   - fallback-версии в `Apps/Mobile/lib/api.ts`, `appLinks.ts`, `avatarUpload.ts`, `communityAvatarUpload.ts`, `Apps/Web/lib/fscp/clientCore.ts`, `Apps/Web/next.config.ts`;
   - корневой `flora-versions.json`, `Products/FSCP/package.json`, `Products/FRC/package.json` (sync их не трогает);
   - `Artifacts/contract-fixtures/api-version.json` — под новый `/version` (ecosystem / products / api);
   - `README.md` — имя APK `flora.social-v<version>-android.apk`.
4. Коммит (GPG): `chore(ecosystem): v<version> release`.

Теги:

```powershell
git tag -s ecosystem/v<version> -m "Flora.Ecosystem v<version>"
git tag -s social/v<version> -m "Flora Social v<version>"
```

## Перед релизом

```powershell
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pwsh ./Tools/validate-architecture-rust.ps1
npm run ci
```

В коммит не включать: `obj/`, `bin/`, `.env`, `secrets/`, `google-services.json`, `Scripts/broadcast.env`, `.next/`, `node_modules/`.

## После коммита

```powershell
# Web + API
cd Apps/Web; .\scripts\deploy.ps1

# Android APK → Apps/Mobile/dist/flora.social-v<version>-android.apk
# (+ flora.social-android-update.json with versionCode / sha256 / sizeBytes)
.\Scripts\mobile-release-android.ps1

# Publish APK + update manifest to GitHub Release (tag social/v<version> must exist on remote)
.\Scripts\mobile-release-android.ps1 -PublishGitHub
```

GitHub Release assets: APK + `flora.social-android-update.json` (sideload auto-update). Prefer `-PublishGitHub` over manual upload.

**Signing:** use the same release keystore for every sideload APK; rotating the key breaks PackageInstaller self-updates.

Опционально — in-app уведомление о версии (после публикации APK; нужен для пользователей без silent-update permission / Android < 12):

```powershell
.\Scripts\setup-app-update-broadcast.ps1
.\Scripts\send-apk-auto-update.ps1 -Production -Confirm
```

Или одной командой после сборки: `.\Scripts\mobile-release-android.ps1 -PublishGitHub -BroadcastUpdate`

Подробности broadcast и silent update — [`Apps/Mobile/README.md`](../../Apps/Mobile/README.md).

## Чеклист

- [ ] `VERSION` — `ecosystem` и `products.social`
- [ ] `npm run version:sync`
- [ ] `Apps/Mobile/app.json` — `versionCode` +1
- [ ] Fallback-версии (Mobile: `api.ts`, `appLinks.ts`, `avatarUpload.ts`, `communityAvatarUpload.ts`; Web: `clientCore.ts`, `next.config.ts`)
- [ ] `flora-versions.json` (корень), FSCP/FRC `package.json`, `api-version.json`
- [ ] `README.md` — имя APK
- [ ] `cargo` fmt / clippy / test (+ `validate-architecture-rust` при необходимости)
- [ ] `npm run ci`
- [ ] `git commit -S` — `chore(ecosystem): v<version> release`
- [ ] Теги `ecosystem/v<version>`, `social/v<version>` (push на remote)
- [ ] `Apps/Web/scripts/deploy.ps1`
- [ ] `Scripts/mobile-release-android.ps1 -PublishGitHub`
- [ ] `send-apk-auto-update.ps1` (рекомендуется: fallback UX)

# Релиз Flora.Ecosystem

Источник версий — [`version`](../../version). Синхронизация — `npm run version:sync` ([`scripts/sync-version.mjs`](../../scripts/sync-version.mjs)).

## Коммит-релиз

1. Обновить `version` (`ecosystem`, `products.social`, `products.gov`, `products.mobile`; при необходимости `products.fscp` / `products.frc-i` / `products.fira`).
   - **social** — продукт Social (API + `apps/Web`).
   - **gov** — портал `apps/Gov`.
   - **mobile** — оболочка `apps/Mobile` (`package.json`, `app.json` `expo.version`). Стартовала с `0.12.0-alpha`, чтобы совпасть с уже установленным APK.
2. `npm run version:sync` — обновит `apps/Web`, `apps/Gov`, `apps/Mobile` (+ `app.json`), `packages/flora-client-core`, `products/FSCP` / `products/FRC`, `flora-versions.json`, `backend/flora-versions.json`, `Cargo.toml` (`# synced-from-VERSION`).
3. Вручную:
   - `apps/Mobile/app.json` — увеличить `expo.android.versionCode` на 1;
   - fallback-версии в `apps/Mobile/lib/api.ts`, `appLinks.ts`, `avatarUpload.ts`, `communityAvatarUpload.ts`, `apps/Web/lib/fscp/clientCore.ts`, `apps/Web/next.config.ts`, `apps/Gov/lib/govApiClient.ts` (`GOV_APP_VERSION`);
   - `artifacts/contract-fixtures/api-version.json` — под новый `/version` (ecosystem / products / api);
   - lockfiles (`package-lock.json`, `apps/Web/package-lock.json`, `apps/Gov/package-lock.json`) — версии workspace-пакетов FSCP/FRC при их bump; корень `flora-gov` при bump `products.gov`;
   - `readme.md` — имя APK `flora-v<version>.apk`.
4. Коммит (GPG): `chore(ecosystem): v<version> release`.

Теги:

```powershell
git tag -s ecosystem/v<version> -m "Flora.Ecosystem v<version>"
git tag -s social/v<version> -m "Flora Social v<version>"
```

APK-канал (`flora-v<version>.apk`) следует `products.mobile`. Release REST — Cloudflare `social.*` (`EXPO_PUBLIC_API_URL`). Latest-указатель остаётся `flora.social-android-update.json` (URL зашит в уже установленных клиентах). Тег `social/v…` — продукт Social (API + Web).

## Перед релизом

```powershell
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pwsh ./tools/validate-architecture-rust.ps1
npm run ci
```

Для релиза retry-safe Auth refresh обязателен отдельный
[`AUTH-SESSION-ROLLOUT.md`](AUTH-SESSION-ROLLOUT.md): migration-first,
двухфазное включение, canary/soak и drain-rollback.

В коммит не включать: `obj/`, `bin/`, `.env`, `secrets/`, `google-services.json`, `scripts/broadcast.env`, `.next/`, `node_modules/`.

## После коммита

```powershell
# Flora Social (API + web) → VPS
.\scripts\deploy-flora-social.ps1

# Flora Gov (Next :3001) → VPS (nginx gov.* уже с social bootstrap)
.\scripts\deploy-flora-gov.ps1

# Android APK → apps/Mobile/dist/flora-v<version>.apk
# (+ flora.social-android-update.json with versionCode / sha256 / sizeBytes)
.\scripts\mobile-release-android.ps1

# Publish APK + update.json + releases.json to Flora channel (VPS /var/www/flora-apk)
# Requires nginx /apk/ (bootstrap or apps/Web/scripts/patch-nginx-apk-channel.sh)
.\scripts\mobile-release-android.ps1 -PublishChannel
```

Канал: `https://social.flora-s.net/apk/` (`releases.json` + `flora-v<version>.apk` для `/download`; `flora.social-android-update.json` указывает на зеркало `flora.social-v<version>-android-{sha8}.apk`, чтобы 0.12 catch-up/FCM прошли allowlist). Prefer `-PublishChannel` over manual upload. Повторная заливка той же версии под тем же каноническим именем требует purge CDN (`/apk/` immutable); sha8-зеркало даёт новый CDN-ключ.

**Signing:** use the same release keystore for every sideload APK; rotating the key breaks PackageInstaller self-updates.

Опционально — in-app уведомление о версии (после публикации APK; нужен для пользователей без silent-update permission / Android < 12):

```powershell
.\scripts\setup-app-update-broadcast.ps1
.\scripts\send-apk-auto-update.ps1 -Production -Confirm
```

Или одной командой после сборки: `.\scripts\mobile-release-android.ps1 -PublishChannel -BroadcastUpdate`

Подробности broadcast и silent update — [`apps/Mobile/README.md`](../../apps/Mobile/README.md).

## Чеклист

- [ ] `version` — `ecosystem`, `products.social`, `products.gov`, `products.mobile` (+ `fscp` / `frc-i` / `fira` при bump)
- [ ] `npm run version:sync`
- [ ] `apps/Mobile/app.json` — `versionCode` +1
- [ ] Fallback-версии (Mobile: `api.ts`, `appLinks.ts`, `avatarUpload.ts`, `communityAvatarUpload.ts`; Web: `clientCore.ts`, `next.config.ts`)
- [ ] `api-version.json` (+ lockfiles при bump FSCP/FRC)
- [ ] `readme.md` — имя APK / ссылка на `/download`
- [ ] `cargo` fmt / clippy / test (+ `validate-architecture-rust` при необходимости)
- [ ] `npm run ci`
- [ ] `git commit -S` — `chore(ecosystem): v<version> release`
- [ ] Теги `ecosystem/v<version>`, `social/v<version>` (push на remote)
- [ ] `scripts/deploy-flora-social.ps1` (API + web)
- [ ] `scripts/deploy-flora-gov.ps1` (Gov Next :3001)
- [ ] nginx `/apk/` на VPS (если ещё не пропатчен)
- [ ] `scripts/mobile-release-android.ps1 -PublishChannel`
- [ ] `send-apk-auto-update.ps1` (рекомендуется: fallback UX)

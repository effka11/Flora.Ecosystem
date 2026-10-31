# Политика безопасности Flora Ecosystem (Security Policy)

## Сообщение об уязвимостях (Reporting)

**Пожалуйста, не открывайте публичные GitHub Issue по уязвимостям.** Используйте ответственное
раскрытие (responsible disclosure):

> Направляйте отчёт приватно на **flora.dev.hub@gmail.com** с темой `[SECURITY]`.

Включите в отчёт: описание, шаги воспроизведения (proof of concept), затронутые компоненты и
предполагаемое воздействие. Мы стараемся ответить в разумные сроки и согласовать дату публикации
исправления. Не эксплуатируйте уязвимость на чужих данных и не публикуйте детали до выпуска фикса.

---

## Что уже реализовано (Security posture)

В рамках подготовки к публичному релизу закрыты release-blocking проблемы:

- **Секреты:** удалены из репозитория и истории; конфигурация — через gitignored-файлы и переменные
  окружения; в репозитории только example-шаблоны с плейсхолдерами.
- **JWT:** убран дефолтный секрет; **fail-fast** при отсутствии или слабости `Jwt:Secret`
  (минимальная длина/энтропия проверяются при старте).
- **Аутентификация:** enforcement **2FA (TOTP)** на логине; **per-account login lockout**
  (блокировка после серии неудачных попыток); **timing-safe** сравнение кодов верификации
  (`CryptographicOperations.FixedTimeEquals`).
- **Rate limiting:** `UseRateLimiter` + политики на login/register/verify/refresh/account-sensitive/
  write/upload; партиционирование по IP (через `X-Forwarded-For`) и по субъекту JWT.
- **Авторизация:** закрыт IDOR приватных сообществ; повторная аутентификация на удалении аккаунта;
  ограничен доступ к gRPC auth; `ValidateToken` не возвращает все claims.
- **Загрузки:** аватары проходят magic-byte валидацию, бюджет пикселей (anti-decompression-bomb) и
  переэнкод; сужены MIME-типы музыки; у ffmpeg/ffprobe — wall-clock timeout и лимиты ресурсов.
- **Web:** security-заголовки (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy,
  Permissions-Policy); `NEXT_PUBLIC_DEV_AUTO_AUTH` и dev-байпассы выключаются в production-сборке;
  `DeveloperExceptionPage` — только в Development.
- **FSCP (SEC-2, errata-5):** сервер криптографически проверяет Ed25519-подпись конверта
  (`fscp_core::verify_envelope_signature`) на send-пути после структурного валидатора формы —
  defense-in-depth, без расшифровки содержимого. Норма: [`documents/fscp/FSCP.md`](documents/fscp/FSCP.md)
  §Server-side validation (Algorithm C шаг 12). Клиентская верификация при decrypt сохраняется.
- **FSCP web device keys (SEC-1):** приватные ключи device profile на вебе **не** хранятся plaintext
  в `localStorage`. At-rest: AES-GCM ciphertext в IndexedDB (`flora-fscp-vault`) под
  неэкспортируемым WebCrypto wrap-ключом (`extractable: false`); one-shot миграция с LS.
  Реализация: [`apps/Web/lib/fscp/sealedVault.ts`](apps/Web/lib/fscp/sealedVault.ts),
  [`apps/Web/lib/fscp/storage.ts`](apps/Web/lib/fscp/storage.ts).
  **Остаточный риск:** при живом XSS злоумышленник всё ещё может вызвать decrypt / адаптер, пока
  вкладка открыта — это hardening at-rest, не XSS-proof. Вытеснение IndexedDB браузером →
  восстановление через password/recovery backup. Ужесточение CSP (`unsafe-inline`) — отдельный
  hardening-проход.
- **FSCP key backup (`epochSetHash`):** после decrypt password/recovery backup клиент пересчитывает
  `epochSetHash` и отклоняет backup при несовпадении с outer metadata.
  Реализация: [`products/FSCP`](products/FSCP) + Web-копия
  [`apps/Web/lib/fscp/keyBackup.ts`](apps/Web/lib/fscp/keyBackup.ts).
- **Auth TOTP at-rest (`auth-totp-sealed`):** `user_accounts.two_factor_secret` не хранится base32
  открытым текстом. Формат `v1:<keyId>:<nonce_b64>:<ct_b64>` (XChaCha20-Poly1305), AAD привязан к
  `user_uuid`, ключ — отдельное кольцо `Auth:TotpKeyRing` в том же secret store, что `Jwt:Secret`.
  Реализация: [`products/Flora.Social/crates/modules/flora-auth`](products/Flora.Social/crates/modules/flora-auth)
  (`infrastructure/totp_at_rest.rs`, `application/totp_reseal.rs`). Production без `Auth:TotpKeyRing`
  не стартует; development остаётся plaintext (эфемерный `Jwt:Secret` не может быть стабильным ключом).
  **Остаточный риск:** компрометация БД вместе с конфиг-ключом → клонирование 2FA; потеря ключа →
  2FA недоступна до точечного сброса (см. runbook ниже).

---

## Runbook: TOTP at-rest

Область действия — Production-развёртывание, где Auth обслуживает Rust-модуль (`Auth:ServeNative=true`).
Development без `Auth:TotpKeyRing` работает в plaintext-режиме; проверочный SQL на dev-БД не применяется.

**Pre-flight (до деплоя):** ожидаем `sealed = 0`.

```sql
SELECT count(*) FILTER (WHERE two_factor_secret IS NOT NULL AND two_factor_secret <> ''
                          AND two_factor_secret NOT LIKE 'v1:%') AS plaintext,
       count(*) FILTER (WHERE two_factor_secret LIKE 'v1:%')       AS sealed
FROM flora_core.user_accounts;
```

**Раскатка:**

1. Доставить ключ на сервер: `Auth__TotpKeyRing__ActiveKeyId`, `Auth__TotpKeyRing__KeyIds__0`,
   `Auth__TotpKeyRing__Key__<id>` в systemd-юнит flora-api **или** gitignored
   `appsettings.Production.json` в `FLORA_CONFIG_DIR`. `scripts/deploy-flora-api.ps1` копирует только
   `backend/appsettings.json` — ключ доставляется отдельным шагом, из secret store.
2. Задеплоить бинарь. Без ключа старт намеренно падает (fail-fast).
3. Наблюдать лог `flora_auth::totp_reseal` (только счётчики), повторять SQL до `plaintext = 0`.

**Ротация ключа:**

1. Добавить новый `keyId` в `Auth:TotpKeyRing:KeyIds`, прописать его ключ, сделать активным
   (`ActiveKeyId`). Старый ключ остаётся в кольце для расшифровки.
2. Дождаться прохода ротации (`resealed` в логе) — воркер перепечатывает строки старого id под активный.
3. Гейт вывода старого ключа — `count = 0` для его id:

```sql
SELECT split_part(two_factor_secret, ':', 2) AS key_id, count(*)
FROM flora_core.user_accounts
WHERE two_factor_secret LIKE 'v1:%'
GROUP BY 1;
```

4. Только после `count = 0` удалить старый key id из `Auth:TotpKeyRing`.

**Откат — только вперёд.** После первой `v1:`-строки старый бинарь её не прочитает, и 2FA-вход сломается.
Окно безопасного отката кода — до первого sealed-ряда; после — только restore БД либо новый код.

**Потеря ключа:** 2FA-вход недоступен. Восстановить ключ из бэкапа secret store, иначе точечный сброс:

```sql
UPDATE flora_core.user_accounts
SET two_factor_secret = NULL, two_factor_enabled = false, updated_at = now()
WHERE user_uuid = $1;
```

Доступ возвращается, пользователь проходит повторный enrolment.

---

## Открытые известные проблемы и допущения

Это не техдолг и не список «багов на потом», а **осознанно открытые** security-проблемы и
by-design допущения текущей версии. Полный реестр (со ссылками на профильные документы) —
[`documents/known/security.md`](documents/known/security.md).

Кратко (часто цитируемое):

1. **Нет ratchet / bootstrap epoch v1** (`fscp-no-ratchet`) — нет forward secrecy и
   post-compromise security между сообщениями FSCP v1.
2. **Двойной FSCP-стек на Web** (`fscp-web-fork`) — `apps/Web/lib/fscp` vs SoT `@flora/fscp`.
3. **SEC-1 остаточный XSS** (`fscp-vault-xss`) — sealed vault закрывает at-rest plaintext в
   `localStorage`, но не живой XSS в открытой вкладке.
4. **Метка «Официальная» APK без SHA** (`mobile-apk-official-no-sha`) — сверка только
   `version` + `versionCode` с каталогом канала.

Эксплуатация с чувствительными данными должна учитывать реестр целиком.

---

## Agent lethal triad (Cursor)

**Летальная триада** = приватные данные + недоверенный контент + внешние действия в одном agent loop.
В этом репозитории для **Cursor Agent** нога «приватные данные» ломается controls ниже; недоверенный контент (PR/чат) сознательно остаётся.

### Что сделано

- [`.cursorignore`](.cursorignore) — Read/@ не видят secret-path (узкие паттерны; не весь `local/`).
- [`.cursor/hooks.json`](.cursor/hooks.json) + [`gate-shell.mjs`](.cursor/hooks/gate-shell.mjs) / [`gate-mcp.mjs`](.cursor/hooks/gate-mcp.mjs):
  - **deny** shell, если в argv есть secret-маркер (`local/.flora`, `SECRETS`, `.env` кроме `*.env*.example`, `broadcast.env`, `*.secret`, path-like `*.pem`, …) — в т.ч. `node -e` / `python -c` / `pwsh -Command`;
  - **ask** на `curl`/`wget`/IWR/`git push`/не-allowlisted `gh` и сетевой MCP (github/playwright/fetch/…);
  - **allow** `cargo`/`npm`/обычные Tools без лишних кликов.
- DoD: `node --test .cursor/hooks/*.test.mjs`

### Остаточный риск

1. Obfuscation **без** secret-маркера в argv (encode / env-indirection).
2. Секрет **открыт во вкладке** → buffer bypass ignore/hooks.
3. User Integrated Terminal **вне** agent hooks.
4. Cloud agents / другие IDE (Zed — см. [`documents/ZED.md`](documents/ZED.md)).
5. Секреты, уже попавшие в чат/логи агента.
6. Будущий FGP AI-клерк — не давать tools/egress (спека: структурирует, не решает).

Секреты и JWT: только user-run терминал (`scripts/ensure-shared-dev-jwt.ps1` и т.п.), не через Agent.

---

## Поддерживаемые версии (Supported Versions)

Проект находится в стадии активной разработки (MVP). Безопасностные исправления выпускаются для
актуальной ветки `main`. Гарантий поддержки старых тегов/форков нет.

---

Контакт по вопросам безопасности: **flora.dev.hub@gmail.com**.
Коммерческие лицензии на Flora Ecosystem и гарантии: **Egor Ozerskikh — e.ozerskikh@gmail.com**
(см. [`license-commercial.md`](license-commercial.md)).

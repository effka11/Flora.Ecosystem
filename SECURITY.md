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
  defense-in-depth, без расшифровки содержимого. Норма: [`Documents/fscp/FSCP.md`](Documents/fscp/FSCP.md)
  §Server-side validation (Algorithm C шаг 12). Клиентская верификация при decrypt сохраняется.
- **FSCP web device keys (SEC-1):** приватные ключи device profile на вебе **не** хранятся plaintext
  в `localStorage`. At-rest: AES-GCM ciphertext в IndexedDB (`flora-fscp-vault`) под
  неэкспортируемым WebCrypto wrap-ключом (`extractable: false`); one-shot миграция с LS.
  Реализация: [`Apps/Web/lib/fscp/sealedVault.ts`](Apps/Web/lib/fscp/sealedVault.ts),
  [`Apps/Web/lib/fscp/storage.ts`](Apps/Web/lib/fscp/storage.ts).
  **Остаточный риск:** при живом XSS злоумышленник всё ещё может вызвать decrypt / адаптер, пока
  вкладка открыта — это hardening at-rest, не XSS-proof. Вытеснение IndexedDB браузером →
  восстановление через password/recovery backup. Ужесточение CSP (`unsafe-inline`) — отдельный
  hardening-проход.
- **FSCP key backup (`epochSetHash`):** после decrypt password/recovery backup клиент пересчитывает
  `epochSetHash` и отклоняет backup при несовпадении с outer metadata.
  Реализация: [`Products/FSCP`](Products/FSCP) + Web-копия
  [`Apps/Web/lib/fscp/keyBackup.ts`](Apps/Web/lib/fscp/keyBackup.ts).

---

## Открытые известные проблемы и допущения

Это не техдолг и не список «багов на потом», а **осознанно открытые** security-проблемы и
by-design допущения текущей версии. Полный реестр (со ссылками на профильные документы) —
[`Documents/known/security.md`](Documents/known/security.md).

Кратко (часто цитируемое):

1. **TOTP-секреты в БД plaintext** (`auth-totp-plaintext`) — компрометация БД клонирует 2FA.
   Refresh-токены в БД уже хранятся как хэш `sha256:`.
2. **Нет ratchet / bootstrap epoch v1** (`fscp-no-ratchet`) — нет forward secrecy и
   post-compromise security между сообщениями FSCP v1.
3. **Двойной FSCP-стек на Web** (`fscp-web-fork`) — `Apps/Web/lib/fscp` vs SoT `@flora/fscp`.
4. **SEC-1 остаточный XSS** (`fscp-vault-xss`) — sealed vault закрывает at-rest plaintext в
   `localStorage`, но не живой XSS в открытой вкладке.
5. **Метка «Официальная» APK без SHA** (`mobile-apk-official-no-sha`) — сверка только
   `version` + `versionCode` с каталогом канала.

Эксплуатация с чувствительными данными должна учитывать реестр целиком.

---

## Agent lethal triad (Cursor)

**Летальная триада** = приватные данные + недоверенный контент + внешние действия в одном agent loop.
В этом репозитории для **Cursor Agent** нога «приватные данные» ломается controls ниже; недоверенный контент (PR/чат) сознательно остаётся.

### Что сделано

- [`.cursorignore`](.cursorignore) — Read/@ не видят secret-path (узкие паттерны; не весь `Local/`).
- [`.cursor/hooks.json`](.cursor/hooks.json) + [`gate-shell.mjs`](.cursor/hooks/gate-shell.mjs) / [`gate-mcp.mjs`](.cursor/hooks/gate-mcp.mjs):
  - **deny** shell, если в argv есть secret-маркер (`Local/.flora`, `SECRETS`, `.env` кроме `*.env*.example`, `broadcast.env`, `*.secret`, path-like `*.pem`, …) — в т.ч. `node -e` / `python -c` / `pwsh -Command`;
  - **ask** на `curl`/`wget`/IWR/`git push`/не-allowlisted `gh` и сетевой MCP (github/playwright/fetch/…);
  - **allow** `cargo`/`npm`/обычные Tools без лишних кликов.
- DoD: `node --test .cursor/hooks/*.test.mjs`

### Остаточный риск

1. Obfuscation **без** secret-маркера в argv (encode / env-indirection).
2. Секрет **открыт во вкладке** → buffer bypass ignore/hooks.
3. User Integrated Terminal **вне** agent hooks.
4. Cloud agents / другие IDE (Zed — см. [`Documents/ZED.md`](Documents/ZED.md)).
5. Секреты, уже попавшие в чат/логи агента.
6. Будущий FGP AI-клерк — не давать tools/egress (спека: структурирует, не решает).

Секреты и JWT: только user-run терминал (`Scripts/ensure-shared-dev-jwt.ps1` и т.п.), не через Agent.

---

## Поддерживаемые версии (Supported Versions)

Проект находится в стадии активной разработки (MVP). Безопасностные исправления выпускаются для
актуальной ветки `main`. Гарантий поддержки старых тегов/форков нет.

---

Контакт по вопросам безопасности: **flora.dev.hub@gmail.com**.
Коммерческие лицензии на Flora Ecosystem и гарантии: **Egor Ozerskikh (Luna) — e.ozerskikh@gmail.com**
(см. [`LICENSE-COMMERCIAL.md`](LICENSE-COMMERCIAL.md)).

# security — открытые известные проблемы и допущения

Живой реестр security-слонов. Не техдолг: каждый пункт — либо **осознанное допущение** модели/MVP, либо **открытая известная проблема**, которую нельзя называть закрытой.

Политика disclosure и список уже закрытого — [`SECURITY.md`](../../SECURITY.md). Источники ниже остаются нормативными; этот файл сводит открытое в одном месте.

Статусы: `открыто` · `допущение` · `остаточный риск` (hardening есть, класс угрозы не снят).

---

## Auth / секреты в БД

| ID | Суть | Риск / следствие | Источник | Статус |
| --- | --- | --- | --- | --- |
| `auth-totp-plaintext` | Секреты TOTP хранятся в БД без шифрования at-rest (`two_factor_secret`) | Компрометация БД → клонирование 2FA | [`SECURITY.md`](../../SECURITY.md); `flora-auth` repo | открыто |

---

## FSCP / E2E (протокол и платформа)

| ID | Суть | Риск / следствие | Источник | Статус |
| --- | --- | --- | --- | --- |
| `fscp-no-ratchet` | Нет Double Ratchet / per-message FS; одна bootstrap key-эпоха и sentinel device UUID в v1 | Нет forward secrecy и post-compromise security между сообщениями; компрометация agreement-ключа эпохи раскрывает сообщения эпохи | [`SECURITY.md`](../../SECURITY.md); [`FSCP.md`](../fscp/FSCP.md) §Forward secrecy, Known MVP limitations; [`e2e-security.md`](../fscp/e2e-security.md) | допущение (v1) |
| `fscp-sig-authenticity` | Клиентская проверка подписи — ключом из самого конверта; целостность, не identity-binding против активного сервера | Активный сервер / подмена identity вне модели v1 authenticity | [`FSCP.md`](../fscp/FSCP.md) §Signature authenticity; [`FSCP-REVIEW.md`](../FSCP-REVIEW.md) | допущение (v1) |
| `fscp-canonical-malleability` | Подпись покрывает canonical JSON, не сырые байты wire | Два wire с одной семантикой → одна подпись; для v1 смягчено AAD + серверной криптопроверкой; полная фиксация байтов — v2 | [`FSCP.md`](../fscp/FSCP.md) §Canonical encoding; [`FSCP-REVIEW.md`](../FSCP-REVIEW.md) п.4 | допущение (v1) |
| `fscp-dual-wire` | Legacy dual-ciphertext API: `encryptedForReceiver` / `encryptedForSender` обязаны быть идентичны | Мост к единому `fscp1:`; лишняя поверхность до выпила | [`FSCP.md`](../fscp/FSCP.md) Known MVP limitations | открыто (мост) |
| `fscp-device-policy-bootstrap` | Device-policy на send-пути не срабатывает на bootstrap sentinel (bindings нет) | Полный enforcement — с per-device UUID в wire (v1.1+) | [`FSCP.md`](../fscp/FSCP.md) Known MVP limitations | допущение (v1) |
| `fscp-web-fork` | Две клиентские поверхности: `Apps/Web/lib/fscp/*` и SoT `@flora/fscp` (реэкспорт `@flora/client-core`) | Дрейф байт-критичных путей; parity покрывает часть модулей, не всю консолидацию | [`FSCP.md`](../fscp/FSCP.md) Known MVP limitations; [`SECURITY.md`](../../SECURITY.md) (Web-копия `keyBackup.ts`); [`next-architecture.md`](../../next-architecture.md) | открыто |
| `fscp-vault-xss` | SEC-1: ключи at-rest в sealed IndexedDB, не plaintext `localStorage`; живой XSS всё ещё может вызвать decrypt, пока вкладка открыта | Hardening at-rest ≠ XSS-proof; вытеснение IDB → restore из backup | [`SECURITY.md`](../../SECURITY.md) posture SEC-1 | остаточный риск |
| `fscp-multitab-mutex` | Мьютекс resolve key backup — один JS-realm; две вкладки могут гоняться через общий storage | Редкая гонка на свежем аккаунте; `navigator.locks` сознательно не внедрён | [`e2e-security.md`](../fscp/e2e-security.md) | допущение |
| `fscp-backup-not-found-ux` | При `backup_not_found` UI может запросить пароль, хотя пароль не поможет (нужны recovery / trusted device) | Ложный UX-путь восстановления | [`e2e-security.md`](../fscp/e2e-security.md) | открыто |
| `fscp-verified-contact` | Safety number в UI 1:1 есть; локальный «verified contact» — future work | TOFU без явной пометки «проверено вручную» | [`FSCP.md`](../fscp/FSCP.md) Known MVP limitations | открыто |

> Заметка соответствия: таблица Known MVP limitations в [`FSCP.md`](../fscp/FSCP.md) всё ещё помечает «E2E-ключи на вебе в localStorage» как известный риск — факт кода: SEC-1 закрыт (sealed vault). Норма здесь и в корневом SECURITY posture; строку в FS.md нужно синхронизировать отдельно.

---

## Клиенты / цепочка поставки

| ID | Суть | Риск / следствие | Источник | Статус |
| --- | --- | --- | --- | --- |
| `mobile-apk-official-no-sha` | Метка «Официальная» сверяет только `version` + `versionCode` с `releases.json`, не SHA установленного APK | Подмена бинарника с тем же version/versionCode проходит как «официальная» | `Apps/Mobile/lib/apkUpdate/channelOfficiality.ts` | открыто |
| `web-csp-unsafe-inline` | Ужесточение CSP (убрать `unsafe-inline`) — отдельный hardening-проход | Расширяет окно XSS при дыре в разметке/скриптах | [`SECURITY.md`](../../SECURITY.md) posture SEC-1 | открыто |

---

## Agent / операционные границы

| ID | Суть | Риск / следствие | Источник | Статус |
| --- | --- | --- | --- | --- |
| `agent-lethal-triad` | Cursor Agent: нога «приватные данные» ломается ignore/hooks; остаточные обходы (obfuscation argv, секрет во вкладке, user terminal, cloud/другие IDE, секреты уже в чате) | Agent loop не равен vault | [`SECURITY.md`](../../SECURITY.md) §Agent lethal triad | остаточный риск |

---

## Закрыто недавно (не тащить обратно как «дыру»)

Краткий якорь, чтобы онбординг и growth не цитировали устаревшее:

| ID | Что закрыто | Где зафиксировано |
| --- | --- | --- |
| `SEC-1` | Device private keys на web не в plaintext `localStorage` | [`SECURITY.md`](../../SECURITY.md) posture |
| `SEC-2` / errata-5 | Серверная Ed25519-проверка подписи envelope | [`SECURITY.md`](../../SECURITY.md); [`FSCP.md`](../fscp/FSCP.md) Algorithm C шаг 12 |
| `epochSetHash` | Клиент отклоняет key backup при несовпадении commitment | [`SECURITY.md`](../../SECURITY.md); [`e2e-security.md`](../fscp/e2e-security.md) |
| `auth-refresh-hashed` | Refresh в БД как `sha256:` | `flora-auth` |
| FSCP-REVIEW 1–3, 5 | Unsigned reject, random signing fallback, FSM DoS, unknown blocks | [`FSCP-REVIEW.md`](../FSCP-REVIEW.md) §Remediation |

---

При эксплуатации с чувствительными данными учитывать открытые и `допущение` строки выше. Disclosure уязвимостей — только по [`SECURITY.md`](../../SECURITY.md) (не публичные issue).

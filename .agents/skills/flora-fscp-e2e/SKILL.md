---
name: flora-fscp-e2e
description: >-
  Запреты и границы FSCP wire и платформенного E2E: замороженный конверт,
  эпохи, backup, устройства, franking, группы. Применять перед правками
  products/FSCP, flora-messaging, flora-chat-organizer, key backup, wire
  сообщений и documents/fscp. UI чата (сетка, стикеры, голос) —
  /apps-web-messages-chat.
---

# FSCP и E2E — карточка запретов

Этот файл не спецификация и не реализация. Числа, JSON, AAD, порядок шагов и строки ошибок брать только из документа в таблице ниже. Не восстанавливать протокол по памяти и не по этой карточке.

Целевой раздел спеки не подменяет текущий wire. Пока правка не назвала слой, код не менять.

## Какой документ читать

| Слой | Документ |
|------|----------|
| Конверт 1:1, алгоритмы A/B/C, подпись, серверный валидатор | `documents/fscp/FSCP.md` |
| Эпохи, backup, recovery, устройства, freeze, FSM | `documents/fscp/e2e-security.md` §Абсолютные инварианты восстановления и §Архитектурное размещение |
| Franking | `documents/fscp/franking.md` §Активация |
| Группы и органайзер | `documents/fscp/groups-and-organizer.md` |

Сетка, compose, стикеры и голосовой UI — skill `/apps-web-messages-chat`, не этот.

## Остановиться, не чинить заодно

Байты FSCP v1, порядок и строки ошибок структурного валидатора (`fscp_wire_validator_v1`) и golden-векторы заморожены. Несовместимое изменение wire — только отдельное решение и major bump (`documents/fscp/FSCP.md` §Versioning), не сопутствующий фикс.

`documents/test-vectors/**` и `artifacts/contract-fixtures/**` руками не редактировать. Новый вектор — регенерация из эталонной реализации, потребители TS и Rust вместе.

## Запрещено

**Сервер и секрет.** Сервер не расшифровывает историю и не получает fallback-ключ, escrow или «ключ для поддержки». Plaintext, E2E root key, приватные ключи устройств, recovery-фразу и ключ открытия backup не писать в БД, логи, телеметрию и security events. Email сам по себе не открывает историю. Recovery-фраза сама по себе не выполняет вход. Обязательное клиентское сканирование E2E запрещено. Единственный канал модерации переписки — добровольный franking.

**Конверт v1.** Не менять форму Algorithm C: `version == 1`, префикс `fscp1:`, `preKeyId == null`, bootstrap epoch, ровно два recipient в DM, `encryptedForReceiver == encryptedForSender`. Не включать в этот конверт pre-keys, Double Ratchet или PQ. Franking в байты v1 не входит, пока `emitFrankTag` выключен; готовый код дельты не вырезать и не активировать. Нет signing-ключа — ошибка сборки, не повод генерировать одноразовый ключ. Пропуск проверки подписи и `allowUnsignedLegacy` по умолчанию запрещены. Серверный шаг 12 проверяет подпись и не заменяет клиентскую проверку; расшифровку рядом с валидатором не добавлять. Подпись v1 не даёт аутентичности против активного сервера — не «усиливать» её сменой wire.

**Эпохи и backup.** Не смешивать сообщения разных эпох без явного `keyEpochId`. Старая история без пароля, recovery-фразы или доверенного устройства остаётся зашифрованной. При account-level `locked` прямой `PUT .../key-backup` отклонён. Восстановление старой эпохи — только `POST .../unlock-complete` в FSM `recovering` (новый backup в теле этого запроса). Отказ от старой истории — только `POST .../epochs` с новым backup в теле; lock старых эпох при этом не снимается. В `active_new_epoch` устройства и сообщения — только для новой primary epoch. Матрицу исключений не сжимать: `documents/fscp/e2e-security.md` §Абсолютные инварианты восстановления.

**Franking.** `emitFrankTag` на боевом send не включать. Пока параметр выключен, байты остаются v1. Включение меняет wire и идёт по трём ступеням `documents/fscp/franking.md` §Активация, не одним флажком. `Messaging:FrankingSigningSeed` не читать, не логировать и не подставлять.

**Клиенты.** Байт-критичный код писать в SoT `@flora/fscp` (`products/FSCP/ts`). В форке `apps/Web/lib/fscp` модули `aad`, `canonicalJson`, `constants`, `deriveIds`, `envelope` менять только вместе с SoT: их сравнивает `products/FSCP/ts/src/webParity.test.ts`, ожидания этого теста не подгонять и не расширять его на другие файлы. Остальной форк (`keyBackup`, `unlockFlow`, `syncOnLogin`, `storage` и соседние) через `webParity.test.ts` не проводить; парную копию в `@flora/fscp` и уже существующий тест модуля (`keyBackup.test.ts`, `syncOnLogin.test.ts`, `bootstrap.test.ts`, `apps/Web/lib/fscp/storage.test.ts`) менять вместе с файлом. `@flora/client-core` — реэкспорт, не вторая реализация. Не добавлять новое plaintext-хранение root key, device private keys и recovery-фразы. Известный `localStorage` не чинить третьим хранилищем; цель описана в `documents/fscp/e2e-security.md` (sealed vault) и в `documents/fscp/FSCP.md` §Known MVP limitations.

## Границы кода

| Место | Что можно |
|-------|-----------|
| `products/FSCP/crates/fscp-core` | Структурная валидация, проверка подписи, вывод id. Без расшифровки истории, БД, HTTP, sqlx, axum, `flora-shared`, Social |
| `@flora/fscp` (`products/FSCP/ts`) | Сборка и открытие конверта на клиенте. SoT байт-критичного TS |
| `flora-messaging` | Хранение ciphertext, backup, устройства, вызов валидатора до записи. Без расшифровки |
| `flora-chat-organizer` | Blob органайзера и `try_validate_organizer_wire`. Plaintext органайзера не разбирать |
| Auth | Пароль, email, сессии, freeze. Без E2E root key и без открытия messaging backup |
| `flora-api` / Social composition | Маршрутизация и DTO. Без крипто и без логики восстановления |
| apps/Web, apps/Mobile | Ключи, KDF, открытие backup и сообщений на клиенте |

Групповой конверт и органайзер не вшивать в DM-wire. AAD-домены не объединять.

## Проверки затронутого слоя

- Конверт и клиент: тесты `@flora/fscp` (golden, transcript, `webParity.test.ts`) и consumer в `fscp-core`.
- Серверная форма: вектор `fscp_wire_validator_v1` и Rust-consumer. Строки ошибок не подгонять под новый код.
- Группы и органайзер: тесты из `documents/fscp/groups-and-organizer.md` §4.
- Ослаблять или удалять проверки, чтобы сошлись байты, нельзя.

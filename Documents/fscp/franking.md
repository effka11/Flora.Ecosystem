# FSCP-FRANK — Message franking для FSCP (RFC, draft)

**Статус:** Draft RFC v0.2 (2026-07-14) — **исполняемый**: эталонная реализация [`franking.ts`](../../Products/FSCP/ts/src/franking.ts) (`@flora/fscp`, реэкспорт `@flora/client-core/fscp`), golden-вектор [`franking-v1.json`](../test-vectors/franking-v1.json) с потребителями TS и Rust (§5). Удовлетворяет gate FGP v2 «franking-RFC в FSCP принят хотя бы как draft» ([`../fgp/FGP.md`](../fgp/FGP.md) §8.3).
**Активация:** wire-дельта v1.1 **реализована в коде**, эмиссия тега **выключена по умолчанию**; в бою не включена. Боевое включение эмиссии — **после** снятия заморозки wire ([`../../next-architecture.md`](../../next-architecture.md) §1.2), см. ступень 3 §Активация ниже. Порядок rollout — три ступени. Без `emitFrankTag` байты FSCP v1 этот документ **не меняет**.
**Нормативные связи:** [`FSCP.md`](./FSCP.md) §Целевой алгоритм → Message franking (обзор), [`e2e-security.md`](./e2e-security.md) §Модерация, [`../fgp/FGP.md`](../fgp/FGP.md) §1.2 п. 7 и §6.5.

---

## Активация

### Статус реализации (код)

Wire-дельта v1.1 реализована в SoT `Products/FSCP/ts` и в форке `Apps/Web/lib/fscp`. Эмиссия тега — явный параметр `emitFrankTag` у `buildFscpWireEnvelope`, проброшен через `buildBlocksMessageWire` / `buildTextMessageWire`; **по умолчанию выключен**. Пока выключен, байты конверта и plaintext совпадают с v1.

При включённом `emitFrankTag`: `frankingKey` (32 байта) в plaintext рядом с `blocks`, `frankTag` на конверте, AAD тела `flora.messaging.message.v1_1` с тегом в суффиксе; тег покрыт подписью Ed25519 отправителя. Decrypt на обеих сторонах разбирает v1 (без тега) и v1.1 (с тегом).

Путь раскрытия у ревьюера — `@flora/fscp` (`frankingDisclosure.ts`): разбор кортежа, разбор plaintext в блоки, фасад verify с различимыми причинами, включая «неверифицируемая» для untagged-сообщений. Типизированная поверхность для потребителя — `@flora/client-core` (`api/franking.ts` + contracts): один вызов отдаёт блоки и вердикт.

Bundle из нескольких сообщений: контейнер `FrankingComplaintBundleV2` из N независимых кортежей под одним seal, кап `FSCP_FRANKING_BUNDLE_MAX_MESSAGES = 20`, wrap в контексте `flora.fscp.franking-wrap.v2` со скоупом клиентского `bundleUuid`; проверка по каждому сообщению отдельно.

`MessageEnvelope.version` остаётся **1**, префикс `fscp1:`, `preKeyId` по-прежнему `null`. Это не v2 и не pre-keys.

### Порядок выкладки (три ступени)

1. **Серверный seed.** На API должен быть валидный секрет `Messaging:FrankingSigningSeed`; иначе любой send с тегом упрётся в `messaging.franking.signing_unavailable` (fail-closed, §4.7).
2. **Decrypt у получателей (floor-версия).** Сборка с decrypt-веткой v1 / v1.1 у **получателей**. Web подхватит на релоаде; Mobile тянет крипту из `@flora/client-core/fscp` внутрь установленного бинаря — старая установка не расшифрует сообщение с тегом (отправитель считает AAD `v1_1`, старый получатель — `v1`). Ступень 2 должна быть подтверждена до ступени 3.
3. **Эмиссия тега.** Только когда сборка с decrypt стала минимальной поддерживаемой версией получателей **и** снята заморозка wire ([`../../next-architecture.md`](../../next-architecture.md) §1.2), приложения включают `emitFrankTag` на боевом send — это момент, когда wire фактически меняется. Пока `emitFrankTag` выключен по умолчанию, байты v1 не меняются и заморозка не нарушается. Если ждать floor-версию нельзя, параметр включается не раньше, чем появится серверный признак min-version / capability, по которому отправитель решает, тегировать ли.

### Операционные проверки (на человеке)

- Выставить секрет `Messaging:FrankingSigningSeed` в окружении целевого env.
- Прогнать аутентифицированную проверку `GET /api/messaging/franking/server-key` на том же env.
- Подтвердить ступень 2 порядка выкладки (floor-версия получателей) до включения ступени 3.

### Вне scope текущей реализации

Следующее **не** реализовано и не следует считать включённым: multi-select в UI чата; приём bundle на стороне Social (форма отчёта и схема БД); обязательное отклонение untagged-сообщений; pre-key pool; Double Ratchet; консолидация Web-форка; ротация серверного ключа франкования.

Gov после claim при совпадении identity pubkey с `wrapTargets.ownItems` показывает `{ blocks, verified }` на клиенте; plaintext на сервер не уходит.

---

## 1. Цель и конституционные рамки

Franking решает единственную задачу: участник E2E-переписки, получивший недопустимое сообщение, может **добровольно** доказать жюри (FGP R1/R2-процесс), что «это сообщение действительно было отправлено этим отправителем через этот сервер» — не раскрывая остальную историю и не давая серверу возможности читать переписку.

Жёсткие рамки (нарушение любого пункта — конституционный конфликт, FGP R3):

- **Никакого клиентского сканирования.** Franking не анализирует содержимое и не сравнивает его с базами. Обязательное client-side scanning запрещено FGP §1.2 п. 7.
- **Никакого серверного раскрытия.** Сервер видит только непрозрачный тег фиксированной длины. Инициировать раскрытие может **только получатель** сообщения.
- **Никакого bulk-раскрытия.** Одна жалоба раскрывает ровно одно сообщение. Ключ franking per-message; из него не выводится ничего для других сообщений.
- **Никакой ретроактивности.** Сообщения FSCP v1 (до активации franking) не франкованы; жалобы на них криптографически **не верифицируемы** и обрабатываются как unverified (policy-решение жюри, не крипто-доказательство).

## 2. Криптографическая мотивация

XChaCha20-Poly1305 (AEAD тела FSCP) **не является key-committing**: один шифртекст может корректно расшифровываться под разными ключами в разные plaintexts. Поэтому «просто показать жюри plaintext и ключ» не доказывает, что отправитель отправил именно это: злонамеренный *получатель* мог бы подобрать другую пару (ключ, plaintext). Franking добавляет явный **commitment** к plaintext, связанный с доставкой через слепую серверную квитанцию — конструкция Grubbs et al. (Message Franking via Committing Authenticated Encryption, CRYPTO'17), развёрнутая в Facebook Messenger.

Схема — «commit-then-encrypt»: HMAC-SHA-256 играет роль commitment (binding при стойкости SHA-256 к коллизиям, hiding при секретном ключе).

## 3. Роли и артефакты

| Артефакт | Размер | Кто создаёт | Кто видит |
| --- | --- | --- | --- |
| `frankingKey` (Kf) | 32 B случайные, per-message | отправитель | отправитель, получатель (внутри шифртекста) |
| `frankTag` | 32 B (HMAC-SHA-256) | отправитель | все, включая сервер (в конверте) |
| `serverFrankReceipt` | подпись Ed25519 64 B + метаданные | сервер при приёме | получатель (при доставке/fetch), жюри (при жалобе) |

## 4. Спецификация

### 4.1. Генерация и commit (отправитель)

1. `frankingKey = random(32)` — CSPRNG, новый на каждое сообщение; переиспользование запрещено.
2. Строка коммита (UTF-8, UUID в нижнем регистре, разделитель ` | ` как в AAD-строках FSCP):

```text
commitInput =
  "flora.fscp.franking.v1"
  | conversationUuid | messageUuid | senderUserUuid | senderDeviceUuid
  | receiverUserUuid | createdAt
  | base64url(SHA-256(plaintextUtf8))
```

`plaintextUtf8` — ровно те байты, что шифруются в тело (§FSCP.md Algorithms, шаг A2): commitment к хешу эквивалентен commitment к plaintext при коллизионной стойкости SHA-256 и не ограничивает размер сообщения.

3. `frankTag = HMAC-SHA-256(frankingKey, commitInput)`.

### 4.2. Размещение в wire (дельта v1.1)

| Место | Поле | Видимость |
| --- | --- | --- |
| plaintext JSON (внутри шифртекста) | `frankingKeyBase64Url` | только участники |
| `MessageEnvelope` (top-level) | `frankTagBase64Url` | сервер видит; поле входит в canonical JSON и покрывается клиентской Ed25519-подписью конверта |
| AAD тела | суффикс ` | frankTagBase64Url` к `messageBodyAadLine` (версия строки — `flora.messaging.message.v1_1`) | привязка тега к шифртексту |

Включение тега в AAD тела — ключевой инвариант: сервер (или посредник), подменивший `frankTag`, ломает расшифровку тела у получателя. Тег, который получатель реально расшифровал, — единственный, который сервер мог заквитировать для этого шифртекста.

### 4.3. Слепая квитанция (сервер, при приёме)

Сервер не видит plaintext и `frankingKey`; он подписывает факт транзита тега:

```text
receiptPayload =
  "flora.fscp.franking-receipt.v1"
  | frankTagBase64Url | messageUuid | conversationUuid
  | senderUserUuid | receiverUserUuid | serverReceivedAt

serverFrankReceipt = {
  signatureBase64Url: Ed25519-Sign(serverFrankingPrivateKey, receiptPayload),
  serverFrankingKeyId,          # ротация ключей; публичные ключи — в key transparency log
  serverReceivedAt              # RFC3339 UTC, миллисекунды
}
```

Сервер хранит receipt рядом с ciphertext и отдаёт его получателю при доставке/fetch. Отсутствие receipt у сообщения v1.1+ — ошибка доставки (клиент показывает предупреждение и не даёт кнопку жалобы).

### 4.4. Жалоба и верификация (жюри)

Получатель-жалобщик раскрывает жюри ровно один кортеж:

```text
{ plaintextUtf8, frankingKeyBase64Url, frankTagBase64Url,
  serverFrankReceipt, messageUuid, conversationUuid,
  senderUserUuid, senderDeviceUuid, receiverUserUuid, createdAt }
```

Жюри верифицирует локально (инструментарий — часть FGP jury tooling):

1. `SHA-256(plaintextUtf8)` → пересобрать `commitInput` (§4.1) → `HMAC(frankingKey, commitInput) == frankTag`;
2. `Ed25519-Verify(serverFrankingPublicKey[keyId], receiptPayload, signature)` — публичный ключ из transparency log, `frankTagBase64Url` в payload равен тегу из шага 1;
3. согласованность метаданных (`messageUuid`, участники, время) между кортежем и receipt.

Все три проверки прошли → доказано: **этот plaintext** с этими метаданными был отправлен указанным отправителем через сервер. Любая проверка упала → жалоба отклоняется как неверифицируемая; повторные фривольные жалобы — по общим правилам FGP §5.5.1.

### 4.5. Свойства безопасности

| Свойство | Механизм |
| --- | --- |
| Отправитель не может отрицать franked-сообщение | commitment покрыт AAD и клиентской подписью конверта; receipt фиксирует транзит |
| Получатель не может подделать жалобу | binding HMAC-SHA-256: нельзя найти (plaintext′, Kf′) с тем же тегом; receipt нельзя изготовить без серверного ключа |
| Сервер не узнаёт содержимое | видит только `frankTag`; hiding HMAC при секретном Kf исключает словарный перебор тега |
| Сервер не может сфабриковать доставку | receipt подписывает только реально принятый тег, привязанный к шифртексту через AAD |
| Непожалованные сообщения не затронуты | Kf per-message; раскрытие одного кортежа не даёт ничего о других сообщениях |
| Deniability | сохраняется против третьих лиц (подпись конверта — «целостность, не аутентичность», FSCP.md §Signature authenticity); осознанно **жертвуется** перед жюри для одного пожалованного сообщения — это цель механизма |

### 4.6. Границы и не-цели

- После ступени 3 §Активация franking обязателен для **отправки** (сообщение без тега сервер отклоняет по форме) — иначе abuse-отправитель просто выключит его. До этого ingest untagged — как в v1 (§4.7); обязательное отклонение — вне scope текущей реализации (§Активация).
- Медиа-блоки: commitment покрывает plaintext JSON тела, включая `assetUuid` и AES-ключи вложений — раскрытие кортежа даёт жюри доступ к конкретному вложению. Отдельный per-asset franking не требуется.
- Групповые чаты — вне scope (отдельный RFC вместе с MLS/sender keys; per-member теги).
- Метаданные, которые видит жюри при жалобе: участники, время, UUID **одного** сообщения. Это осознанная цена доказуемости.

### 4.7. Продуктовая очередь (exclusive claim, 1:1)

Реализация в модуле Messaging. FGP §6.5 задаёт конституцию («только добровольная жалоба, без сканирования»); продукт моделирует «жюри» как **одного ревьюера с эксклюзивным claim** и явным forward. Группы — вне scope (§4.6). Сервер **никогда** не видит plaintext и `frankingKey`; HMAC проверяет клиент ревьюера.

**Ingest.** Нет `frankTagBase64Url` → доставка как в v1, квитанции нет. Тег есть и задан `Messaging:FrankingSigningSeed` → сервер подписывает `receiptPayload` (§4.3), `messageUuid` = **wire** uuid, `serverReceivedAt` = RFC3339 UTC с миллисекундами, пишет `user_message_frank_receipts`. Тег есть, seed нет → **fail-closed**: строка в `user_messages` не создаётся, стабильный код `messaging.franking.signing_unavailable` (согласовано с §4.3: нет receipt у tagged = ошибка доставки, не silent unverifiable).

**Fetch участникам.** GET thread/messages отдаёт аддитивные optional `serverFrankReceipt` и `frankTagBase64Url` из таблицы квитанций (не клиентский blob). Старые клиенты поля игнорируют. Тот же receipt отдаётся claimerу на GET disclosure.

**Viewer-wrap vs backup репортёра.** Наполнение заявки — непрозрачный `disclosureCiphertext` (клиент шифрует на случайный `reportContentKey`). Capability зрителя — живая wrap-строка `{userUuid, deviceUuid, wrappedKey}` на **аккаунт ревьюера**. Цели wrap: Active-строки `user_device_keys` и опубликованный identity agreement key в `user_e2e_keys` (bootstrap v1: чат не пишет `user_device_keys`). Gov **не** регистрирует новое Active-устройство; restore identity на клиенте должен совпасть с pubkey цели. Backup wrap репортёра на **свои** устройства / identity — не capability: нужен, чтобы с другого устройства сделать late-wrap claimerу; в `viewerAccountCount` **не входит**.

Канон аудита зрителей: `viewerAccountCount = COUNT(DISTINCT user_uuid)` живых wrap, где `user_uuid <> reporter_user_uuid`. Не число HTTP GET. Forward увеличивает счётчик. Репортёр не зритель (он уже получатель сообщения). Кап живых viewer-аккаунтов — 5 (claimer + forwards).

**Exclusive claim.** `UPDATE … WHERE status = 'open'` (иначе 409). Claimer — активный ревьюер roster, **не** репортёр и **не** accused (отправитель). Viewer-wrap / forward / disclosure на accused запрещены, даже если отправитель в roster. Accused не видит очередь и GET report (404). GET audit — не сторона спора. Roster не загружен — 503 для всех, кроме reporter / claimer / живой viewer-wrap (accused не отличает отсутствие заявки). После первого claim viewer-wrap других ревьюеров уничтожаются; backup репортёра не трогают. Ciphertext + viewer-wrap callerа отдаются **только** после claim и **только** аккаунтам с живым viewer-wrap (claimer или forward); иначе 403. Очередь — страница до 200 live-заявок, `hasMore` и `nextCursor` (keyset `created_at` RFC3339 с микросекундами, `report_uuid`). Очередь и GET report — только мета (`category`, `status`, `viewerAccountCount`, `hasDisclosure`, публичные `reporterUsername` / `accusedUsername` участников 1:1), без ciphertext и без `frankingKey`. `claimedBy` / `claimedAt` видит ревьюер (очередь, GET). Репортёру claimer **не** отдаётся, кроме статуса `claimed_awaiting_disclosure` (иначе late-wrap не нацелить на устройства claimerа) — в том числе если репортёр сам в roster: очередь по своей заявке прячет claimerа так же, как GET.

Опциональные submit-time viewer-wrap на текущий активный roster — только в теле `POST /reports`. Если жалобщик сразу уйдёт оффлайн, claimer с wrap в этом наборе сразу в `claimed`. Остаточный риск: дамп БД *до* claim + украденный ключ устройства ревьюера. Серверного escrow нет. После submit набор roster не расширять (иначе обход exclusive claim): late `POST …/wraps` — backup на устройства репортёра или viewer-wrap **только на текущего claimerа**.

FSM: `open` → claim с wrap claimerа → `claimed`; без wrap → `claimed_awaiting_disclosure`. Release (только claimer) → `open`, `claimed_by` и `claimed_at` = NULL, все viewer-wrap уничтожены, backup оставлен; следующий claimer всегда в `claimed_awaiting_disclosure`, пока репортёр не сделает late-wrap. `claimed` → forward (кап 5) остаётся `claimed`; resolve/reject — терминальные, доступны claimerу из `claimed` и `claimed_awaiting_disclosure` (civic close без wrap; GET disclosure по-прежнему только при живом viewer-wrap), после этого disclosure больше не отдавать.

**Unverifiable.** Жалоба на untagged сообщение (нет receipt) имеет `verificationStatus = unverifiable`. Жалобщик обязан быть **receiver** сообщения; 1:1 only. Unique `(reporter, message)` — повторная жалоба после resolve/reject на то же сообщение тем же репортёром не создаётся. **Живая** заявка держит ciphertext: `DELETE` сообщения блокируется, пока статус `open` / `claimed` / `claimed_awaiting_disclosure`. После resolve/reject строка заявки больше не держит DM (`ON DELETE CASCADE`); квитанция по-прежнему `CASCADE` вместе с ciphertext, когда заявки уже нет.

## 5. Тест-векторы (выполнено)

[`Documents/test-vectors/franking-v1.json`](../test-vectors/franking-v1.json) — генератор `_gen_fscp_franking_v1.py`, франкует **сообщение golden-транскрипта** `fscp-message-transcript-v1.json` (жалоба доказуема для реального wire; регенерировать транскрипт первым):

- позитив: `commitInput`, `frankTag`, `receiptPayload`, подпись сервера, полный verify-путь жюри;
- негативы с точной причиной отказа: `plaintext_tampered` и `franking_key_wrong` (commit-mismatch), `receipt_signature_tampered` и `receipt_time_mismatch` (receipt-signature-invalid), `message_uuid_mismatch` — демонстрирует, что metadata-binding срабатывает уже на HMAC-шаге (uuid входит в commitInput).

Потребители: TS [`frankingVector.test.ts`](../../Products/FSCP/ts/src/frankingVector.test.ts) (эталон `franking.ts` в `@flora/fscp`), Rust [`fscp_franking_vectors.rs`](../../Backend/Tests/parity/tests/fscp_franking_vectors.rs) (детерминированное воспроизведение серверной подписи из seed — Rust как серверный подписант).

Wire-дельта v1.1 и bundle v2 закреплены отдельными golden (регенерация из `@flora/fscp`, руками JSON не править): [`fscp-franking-wire-v1_1.json`](../test-vectors/fscp-franking-wire-v1_1.json) (Algorithm A + recorded tagged `fscp1:` + подмена `frankTag`) и [`fscp-franking-disclosure-bundle-v2.json`](../test-vectors/fscp-franking-disclosure-bundle-v2.json) (канонические байты кортежа, bundle, wrap v2). Потребители: TS `frankingWireVectorV1_1.test.ts` / `frankingDisclosureBundleVector.test.ts`; Rust [`fscp_franking_wire_v1_1.rs`](../../Backend/Tests/parity/tests/fscp_franking_wire_v1_1.rs) (ingest `try_validate_wire` + `verify_envelope_signature` + HMAC/AAD). Замороженный [`franking-v1.json`](../test-vectors/franking-v1.json) этими векторами **не** заменяется.

## 6. Открытые вопросы

- Ротация `serverFrankingKey` и её публикация: отдельный лог или общий key transparency (FSCP.md §Key transparency phase 2).
- Формат экспорта кортежа жалобы для jury tooling (FGP §5): сериализация, срок хранения receipt на сервере.
- Взаимодействие с retention/`disappearing messages` (если появятся): receipt не должен переживать удаление ciphertext.
- Совместимость с потенциальным sealed sender (v2+): `receiptPayload` содержит `senderUserUuid` — при скрытии отправителя от сервера аттестация квитанции сводится к (tag, conversation, receiver, ts), атрибуция отправителя остаётся на `commitInput` + подписи конверта; потребует ревизии §4.3.

---

*Обзорная схема — [`FSCP.md`](./FSCP.md) §Целевой алгоритм → Message franking. Конституционные рамки — [`../fgp/FGP.md`](../fgp/FGP.md) §1.2, §6.5, §8.3.*

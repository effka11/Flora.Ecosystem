# FSCP-FRANK — Message franking для FSCP (RFC, draft)

**Статус:** Draft RFC v0.2 (2026-07-14) — **исполняемый**: эталонная реализация [`franking.ts`](../../Packages/flora-client-core/src/fscp/franking.ts), golden-вектор [`franking-v1.json`](../test-vectors/franking-v1.json) с потребителями TS и Rust (§5). Удовлетворяет gate FGP v2 «franking-RFC в FSCP принят хотя бы как draft» ([`../fgp/FGP.md`](../fgp/FGP.md) §8.3).
**Активация:** FSCP v1.1+ — **после** снятия заморозки wire ([`../../next-architecture.md`](../../next-architecture.md) §1.2). Байты FSCP v1 этот документ **не меняет**.
**Нормативные связи:** [`FSCP.md`](./FSCP.md) §Целевой алгоритм → Message franking (обзор), [`e2e-security.md`](./e2e-security.md) §Модерация, [`../fgp/FGP.md`](../fgp/FGP.md) §1.2 п. 7 и §6.5.

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

- Franking обязателен для **отправки** в v1.1+ (сообщение без тега сервер отклоняет по форме) — иначе abuse-отправитель просто выключит его.
- Медиа-блоки: commitment покрывает plaintext JSON тела, включая `assetUuid` и AES-ключи вложений — раскрытие кортежа даёт жюри доступ к конкретному вложению. Отдельный per-asset franking не требуется.
- Групповые чаты — вне scope (отдельный RFC вместе с MLS/sender keys; per-member теги).
- Метаданные, которые видит жюри при жалобе: участники, время, UUID **одного** сообщения. Это осознанная цена доказуемости.

## 5. Тест-векторы (выполнено)

[`docs/test-vectors/franking-v1.json`](../test-vectors/franking-v1.json) — генератор `_gen_fscp_franking_v1.py`, франкует **сообщение golden-транскрипта** `fscp-message-transcript-v1.json` (жалоба доказуема для реального wire; регенерировать транскрипт первым):

- позитив: `commitInput`, `frankTag`, `receiptPayload`, подпись сервера, полный verify-путь жюри;
- негативы с точной причиной отказа: `plaintext_tampered` и `franking_key_wrong` (commit-mismatch), `receipt_signature_tampered` и `receipt_time_mismatch` (receipt-signature-invalid), `message_uuid_mismatch` — демонстрирует, что metadata-binding срабатывает уже на HMAC-шаге (uuid входит в commitInput).

Потребители: TS [`frankingVector.test.ts`](../../Packages/flora-client-core/src/fscp/frankingVector.test.ts) (эталон `franking.ts`), Rust [`fscp_franking_vectors.rs`](../../Backend/tests/parity/tests/fscp_franking_vectors.rs) (включая детерминированное воспроизведение серверной подписи из seed — Rust как будущий подписант). C#-consumer — вместе с серверной реализацией при активации v1.1.

## 6. Открытые вопросы

- Ротация `serverFrankingKey` и её публикация: отдельный лог или общий key transparency (FSCP.md §Key transparency phase 2).
- Формат экспорта кортежа жалобы для jury tooling (FGP §5): сериализация, срок хранения receipt на сервере.
- Взаимодействие с retention/`disappearing messages` (если появятся): receipt не должен переживать удаление ciphertext.
- Совместимость с потенциальным sealed sender (v2+): `receiptPayload` содержит `senderUserUuid` — при скрытии отправителя от сервера аттестация квитанции сводится к (tag, conversation, receiver, ts), атрибуция отправителя остаётся на `commitInput` + подписи конверта; потребует ревизии §4.3.

---

*Обзорная схема — [`FSCP.md`](./FSCP.md) §Целевой алгоритм → Message franking. Конституционные рамки — [`../fgp/FGP.md`](../fgp/FGP.md) §1.2, §6.5, §8.3.*

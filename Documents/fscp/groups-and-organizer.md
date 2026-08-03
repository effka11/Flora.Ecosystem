# FSCP-G v1 и FSCP-ORG v1 — групповые чаты и организатор чатов

Статус: **draft → implemented (v1)**. Дата: 2026-08-02.

Две независимые спецификации поверх криптопримитивов FSCP v1
([`FSCP.md`](FSCP.md)). Замороженный DM-wire `fscp1:` **не изменяется**;
новые конверты используют собственные префиксы и AAD-домены, поэтому
старые валидаторы отклоняют их целиком, а перенос ciphertext между
доменами ломает AEAD-tag.

| Спека | Префикс | Назначение | SoT (клиент) | SoT (сервер) |
| --- | --- | --- | --- | --- |
| FSCP-G v1 | `fscpg1:` | групповые сообщения | `Products/FSCP/ts/src/group.ts` | `Products/FSCP/crates/fscp-core/src/group.rs` |
| FSCP-ORG v1 | `fscporg1:` | папки/архив/mute как E2E-blob | `Products/FSCP/ts/src/chatOrganizer.ts` | `Products/FSCP/crates/fscp-core/src/organizer.rs` |

Константы (`fscp-contracts` ⇄ `@flora/fscp`):
`GROUP_WIRE_PREFIX = "fscpg1:"`, `GROUP_MAX_MEMBERS = 128`,
`ORGANIZER_WIRE_PREFIX = "fscporg1:"`.

---

## 1. FSCP-G v1 — групповой конверт

### 1.1 Модель

- **Pairwise fan-out**: одно сообщение = один конверт с массивом
  `recipients[]`, где для каждого активного участника группы (включая
  self-copy отправителя) есть отдельный RKE
  (x25519-hkdf-xchacha20poly1305), завёрнутый на его agreement public
  key. MLS/sender-keys сознательно не используются — v1 наследует
  MVP-грейд FSCP (без Double Ratchet), безопасность соответствует DM v1.
- `conversationUuid` — **server-issued** UUID группы (в отличие от DM,
  где UUID детерминированно выводится из пары).
- Лимит: `1..=128` записей `recipients` (совокупно с отправителем).
- Метаданные группы (название, ростер) серверу видны — это необходимое
  условие маршрутизации и валидации ростера. E2E-защищено содержимое
  сообщений.

### 1.2 Wire

`fscpg1:` + base64url(JSON конверта). Форма конверта — как у DM v1
(`version`, `messageUuid`, `conversationUuid`, `keyEpochId`,
`senderUserUuid`, `senderDeviceUuid`, `messageKeyId`, `createdAt`,
`ciphertextBase64Url`, `aead{name,nonceBase64Url}`, `recipients[]`,
`senderSigningPublicKeyBase64Url`, `senderSignatureBase64Url`), но:

- `recipients[]` отсортированы по `(userUuid, deviceUuid)` (code units,
  lowercase) — детерминизм canonical JSON;
- подпись Ed25519 над
  `"flora.messaging.group-envelope-signature.v1 | " + canonicalJson(конверт без подписи)`;
- **неподписанные конверты отклоняются всегда** (группового
  legacy-архива не существует).

### 1.3 AAD-домены

- Тело: `flora.messaging.group-message.v1 | conversationUuid | keyEpochId | messageUuid | messageKeyId | senderUserUuid | senderDeviceUuid | createdAt`
- RKE: `flora.messaging.group-recipient-key-envelope.v1 | conversationUuid | keyEpochId | messageUuid | messageKeyId | senderUserUuid | senderDeviceUuid | recipientUserUuid | recipientDeviceUuid | recipientAgreementPublicKeyId`

UUID-компоненты — lowercase; `createdAt` — как в конверте.

### 1.4 Серверная валидация (`fscp-core::group`)

`try_validate_group_wire(wire, sender_user_uuid, conversation_uuid, active_member_uuids, current_key_epoch_id)`:

1. префикс/base64url/JSON/`version == 1`;
2. `senderUserUuid` == аутентифицированный отправитель; `conversationUuid`
   == целевая группа; `keyEpochId` == текущая эпоха;
3. **ростер**: множество `recipients[].userUuid` == множество активных
   участников группы (по данным `flora-messaging`), без дублей,
   отправитель присутствует (self-copy);
4. подпись Ed25519 проверяется по `senderSigningPublicKeyBase64Url`
   (+ сверка с доверенным ключом подписи отправителя из справочника);
5. лимиты размера wire.

Сервер **не расшифровывает** payload. Сообщение сохраняется одной
строкой (общий wire), доставка — по членству в группе.

### 1.4.1 Медиа (voice / image)

Plaintext блоков тот же, что у DM (`voice` / `image` с `assetUuid` +
AES-GCM descriptor; см. [`FSCP.md`](FSCP.md)). Байты файла — opaque
object в Messaging:

- таблицы `group_message_voice_assets` / `group_message_image_assets`
  (`conversation_uuid`, uploader, optional `message_uuid`);
- upload: `POST /api/messaging/groups/{conversationUuid}/voice|image-assets`
  (только active member);
- download: существующие `GET /api/messaging/voice|image-assets/{uuid}`
  (lookup DM, иначе group; ACL = uploader или active member);
- bind UUID lists на `POST …/groups/{id}/messages` (как DM draft→bind).

**Видео в группах v1 не поддерживается** (`videoAssetUuids` → 400).
Клиентский helper: `buildGroupBlocksMessageWire` (`groupMessaging.ts`).

### 1.5 Смена ростера

- Добавление участника: он читает только сообщения, отправленные после
  добавления (нет RKE в старых конвертах — история недоступна, PCS-lite).
- Удаление: сервер перестаёт принимать конверты, где удалённый есть в
  `recipients`, и конверты без него не проходят проверку ростера у
  оставшихся. Удалённый не получает новых сообщений.
- Ключ группы не существует как long-term secret — каждый конверт несёт
  свежий `messageKey`, поэтому смена ростера не требует rekey.

## 2. FSCP-ORG v1 — организатор чатов (папки/архив/mute)

### 2.1 Модель

Всё состояние организации чатов — **одно E2E-зашифрованное значение**
на пользователя (per-account blob), сервер хранит `(owner, revision,
wire)` и не видит ни названий папок, ни состава, ни архива/mute.
Заменяет plaintext-overlay (`user_chat_folders` /
`user_conversation_flags`).

Plaintext-схема (`FscpOrganizerStatePlaintext`):

```json
{
  "type": "chat-organizer",
  "version": 1,
  "entities": [
    {
      "id": "…", "kind": "folder|group", "label": "…", "icon": "…",
      "avatarUri": null,
      "memberPeerUuids": ["…"],
      "memberConversationUuids": ["…"],
      "createdAtMs": 0
    }
  ],
  "archivedByPeer": { "<peerUuid>": true },
  "mutedByPeer": { "<peerUuid>": true },
  "archivedByConversation": { "<conversationUuid>": true },
  "mutedByConversation": { "<conversationUuid>": true },
  "clientUpdatedAt": "ISO-8601"
}
```

Лимиты: ≤ 64 сущностей, label ≤ 80 символов. Неизвестные поля/kind
игнорируются (forward-compat).

### 2.2 Криптография

- plaintext → compact JSON → `padPlaintextJsonV1` (бакеты) →
  XChaCha20-Poly1305 случайным `stateKey` (32 байта);
- `stateKey` завёрнут **self-RKE** на собственный agreement public key
  владельца (тот же материал, что для DM; доступен всем устройствам
  через password/recovery backup и login handoff — см.
  [`e2e-security.md`](e2e-security.md));
- подпись Ed25519:
  `"flora.messaging.chat-organizer-signature.v1 | " + canonicalJson(конверт без подписи)`.

AAD-домены:

- тело: `flora.messaging.chat-organizer.v1 | ownerUserUuid | keyEpochId | revision | updatedAt`
- key envelope: `flora.messaging.chat-organizer-key-envelope.v1 | ownerUserUuid | keyEpochId | revision | recipientAgreementPublicKeyId`

### 2.3 Ревизии и конкуренция устройств

- `revision` — монотонный счётчик (≥ 1), назначается клиентом как
  `current + 1`; сервер принимает **только** `revision == stored + 1`
  (optimistic concurrency, 409 при гонке — клиент перечитывает и
  повторяет поверх свежего состояния).
- `revision` входит в AAD тела и key envelope: сервер не может подменить
  ciphertext одной ревизии ciphertext'ом другой. Полный rollback ловится
  клиентом сравнением с локально закэшированной ревизией.

### 2.4 Серверная валидация (`fscp-core::organizer`)

`try_validate_organizer_wire(wire, owner_user_uuid, expected_revision, current_key_epoch_id)`:
префикс/форма/версия; `ownerUserUuid` == аутентифицированный владелец;
`revision == expected`; `keyEpochId` == текущая эпоха;
`keyEnvelope.recipientAgreementPublicKeyId` == derived id владельца;
подпись Ed25519. Payload серверу недоступен.

### 2.5 Исключение: badge-mirror архива (plaintext flags)

ORG blob остаётся SoT для UI (папки, архив, mute). Сервер **не** читает
plaintext ORG. Для бейджа непрочитанного и лимита слотов иконок нужен
серверный сигнал «этот чат в архиве у владельца» — без расшифровки blob.

**Исключение из «сервер не знает об архиве»:** клиент после успешной
записи ORG зеркалит флаг архива в plaintext Messaging-таблицы
(только `is_archived`, без названий папок и mute-ORG):

| Канал | SoT (ORG) | Mirror (SQL) | HTTP |
| --- | --- | --- | --- |
| DM | `archivedByPeer` (+ side-write conversation) | `user_conversation_flags` | `POST /api/messaging/conversations/{uuid}/archive\|unarchive` |
| Группа (FSCP-G) | `archivedByConversation` | `user_group_conversation_flags` (FK CASCADE на conversation; clear при leave) | `POST /api/messaging/groups/{uuid}/archive\|unarchive`; список — `GET /api/messaging/group-archive-flags` |

`GET /api/messaging/unread-count` суммирует DM + group unread **без**
архивированных (DM — exclude по `user_conversation_flags`, группы — по
`user_group_conversation_flags`). Клиентский intent для групп —
`setGroupArchived` (только conversation map); DM `setArchived` к группам
не применяют. Reconcile зеркала — двусторонний ∩ sticky known groups
после первого успешного `list_groups`. Mute групп и FCM-gate — вне скоупа.

## 3. Границы модулей

- **`fscp-core` / `@flora/fscp`** — только протокол (структурная
  валидация + сборка/открытие конвертов). Никакой БД/HTTP.
- **`flora-messaging`** — группы: ростер, хранение wire, opaque media
  assets + membership ACL, доставка, вызов `try_validate_group_wire`
  перед записью.
- **`flora-chat-organizer`** (отдельный модуль) — blob-хранилище
  органайзера: `(owner, revision, wire)`, вызов
  `try_validate_organizer_wire`, optimistic concurrency. Не знает о
  структуре plaintext.
- Клиенты (Web/Mobile) — сборка/открытие конвертов локально; приватные
  ключи не покидают клиент.

## 4. Тест-покрытие

- TS: `Products/FSCP/ts/src/group.test.ts` (roundtrip, посторонний,
  подделка, лимиты, разделение доменов AAD),
  `chatOrganizer.test.ts` (roundtrip, opaque-для-сервера, привязка
  ревизии, владелец); `@flora/client-core` — folders/organizer
  (`setGroupArchived`, icon counts, filter order).
- Rust: unit-тесты в `fscp-core/src/group.rs` и `organizer.rs`
  (валидный wire, чужая группа/владелец, tampering, ростер, ревизия);
  smoke `flora-messaging` — `archived_group_excluded_from_unread_count`
  (`FLORA_MESSAGING_SMOKE=1`).

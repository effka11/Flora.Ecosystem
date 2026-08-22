# FSCP — Flora Secure Communication Protocol

**Status:** Released  
**Version:** 1.0  
**Date:** 2026-05-10 (spec freeze)

---

## Overview

FSCP (Flora Secure Communication Protocol) — протокол защищённого **личного чата** в экосистеме FLORA. Он задаёт криптографические цели, wire-format, состояние сессии 1:1, согласование ключей сообщения и правила серверной валидации **без расшифровки** payload.

Платформенный контур (key epochs, backup/recovery, FSM аккаунта, API messaging, freeze, rate limits) описан в [`e2e-security.md`](./e2e-security.md). FSCP **опирается** на него, но **владеет** каналом «сообщение ↔ доставка ↔ клиенты».

Этот документ нормативен: реализация wire и клиентской криптографии сообщений **обязана** соответствовать описанным здесь правилам.

**Смежные нормативные документы:**

- [`e2e-security.md`](./e2e-security.md) — платформенный контур (epochs, backup/recovery, FSM, devices, freeze).
- [`franking.md`](./franking.md) — FSCP-FRANK, RFC-draft message franking (модерация E2E по добровольной жалобе; активация v1.1+).
- [`../fgp/FGP.md`](../fgp/FGP.md) — governance. FSCP реализует конституционные инварианты FGP §1.1–§1.2: «тайна переписки» (сервер хранит только ciphertext) и запрет обязательного клиентского сканирования (§1.2 п. 7). Модерация E2E-пространства проходит **только** по добровольной жалобе через message franking (FGP §6.5, см. §Целевой алгоритм → Message franking).
- [`../../next-architecture.md`](../../next-architecture.md) §1.2, §4.4 — на время миграции бэкенда на Rust wire FSCP v1 и bootstrap-epoch **заморожены**; сервер лишь воспроизводит структурную валидацию бит-в-бит.
- [`../FSCP-REVIEW.md`](../FSCP-REVIEW.md) — ревью спецификации и реализации (2026-07-14): вердикт, actionable-находки, расхождения docs↔факт, порядок remediation.

**Ревизии:**

| Ревизия | Дата | Содержание |
| --- | --- | --- |
| v1.0 | 2026-05-10 | Первичная норма (spec freeze). |
| v1.0-errata-1 | 2026-07-13 | Byte-neutral errata (без смены wire): явные алгоритмы v1 (§Algorithms), точная модель подписи (§Signature authenticity), синхронизация plaintext-схемы с реализацией, фиксация порядка сортировки canonical, документирование серверной проверки `recipientAgreementPublicKeyId`, честный conformance-статус. Добавлен §Целевой алгоритм (v1.1/v2 + franking) как roadmap. Кросс-ссылки на FGP и next-architecture. Wire-байты **не изменены**. |
| v1.0-errata-2 | 2026-07-13 | Byte-neutral: полный golden-транскрипт `fscp_message_transcript_v1` (потребители TS/Rust/C#, покрыты все байт-критичные пути Algorithm A/B, включая canonical JSON и подпись); franking вынесен в полноценный RFC-draft [`franking.md`](./franking.md) (gate FGP §8.3 выполнен). Wire-байты **не изменены**. |
| v1.0-errata-3 | 2026-07-14 | Byte-neutral: franking стал исполняемым (эталон `franking.ts` + вектор `fscp_franking_v1`, потребители TS/Rust, франкуется сообщение транскрипта); референсная FSM `FscpV1ConversationSession` реализована в client-core; добавлен нормативный §Post-quantum (гибрид X25519+ML-KEM-768, PQXDH-направление, gate v2). Wire-байты **не изменены**. |
| v1.0-errata-4 | 2026-07-14 | Byte-neutral: §Post-quantum получил конкретную инстанциацию гибридного комбинера (v2-draft) и golden-вектор `fscp_hybrid_kem_v2draft_v1` — три независимые реализации ML-KEM-768 (kyber-py / @noble/post-quantum / RustCrypto), потребители TS + Rust, негативы на implicit rejection FIPS 203. Продакшн-код и wire v1 **не изменены**. |
| v1.0-errata-5 | 2026-07-19 | Hardening по итогам [`FSCP-REVIEW.md`](../FSCP-REVIEW.md) (формат конверта **не изменён**): (1) клиент отклоняет неподписанные конверты по умолчанию — downgrade-окно закрыто, архивы только через явный `allowUnsignedLegacy`; (2) убран fallback на случайный ключ подписи при сборке — отсутствие ключа теперь ошибка; (3) сбои decrypt классифицируются (`FscpDecryptFailureCategory`), в `compromised_local` ведут только подряд идущие key-mismatch-сбои (порог 3) — DoS от собеседника закрыт; (4) неизвестные `block.kind` сохраняются placeholder'ами (forward-compat); (5) паддинг plaintext до бакетов (§MessageEnvelope) — скрытие длины сообщения; (6) серверная **криптопроверка** Ed25519-подписи конверта (`fscp_core::verify_envelope_signature`) после замороженного структурного валидатора; (7) plaintext-превью для push удалены (см. [`e2e-security.md`](./e2e-security.md) §Уведомления). Wire-совместимость: паддинг живёт внутри AEAD-plaintext (top-level поле `pad`, игнорируется читателем), сами байты конверта — та же схема. |

---

## Goals & Non-Goals

**Goals:**

- Конфиденциальность и целостность plaintext сообщений при модели «сервер хранит ciphertext, не имея ключа к истории».
- Явные версии, AAD и проверяемость (test vectors, server-side validation).
- Привязка к `keyEpochId`, device keys и подписи epoch identity.
- Честное разделение MVP v1 и target (pre-keys, Double Ratchet, key transparency).

**Non-Goals:**

- Модель аккаунта, password/recovery backup, trusted devices, freeze — зона [`e2e-security.md`](./e2e-security.md).
- Групповой чат (MLS и т.д.) — вне FSCP v1.
- Полная эквивалентность Signal Double Ratchet в v1 — **target**, см. §Forward secrecy.
- Публикация FSCP как внешний открытый стандарт.

---

## Architecture Position

FSCP — криптографический слой **сообщений** внутри продукта. Бизнес-логика доставки — модуль `Flora.Messaging`; HTTP-композиция — `Products/Flora.Social`.

```
Apps/Web, Apps/Mobile
  └─→ Flora.API
        └─→ Flora.Social (composition)
              └─→ Flora.Messaging (messages, E2E state)
                    ↑ контекст key epochs / devices из e2e-security
```

**Слои FSCP:**

```mermaid
flowchart TB
  subgraph account["Слой аккаунта (e2e-security.md)"]
    A[Key epochs / device keys / recovery]
  end
  subgraph fscp["FSCP"]
    T[Транспорт: хранение ciphertext, API, idempotency]
    E[Конверт: fscp1 wire + MessageEnvelope]
    S[Сессия 1:1: состояние на клиенте]
  end
  account --> T
  T --> E
  E --> S
```

| Слой | Ответственность |
| --- | --- |
| Транспорт | REST, `deviceSetRevision`, отзыв устройств — без plaintext |
| Конверт | `fscp1:` + JSON `MessageEnvelope`, per-device RKE |
| Сессия | `FscpV1ConversationSession`, safety number, re-handshake |

---

## Principles

1. **E2E по смыслу продукта.** Plaintext только на клиентах; сервер не согласует `messageKey`.
2. **Явные версии.** Изменение wire или крипто-логики → новый `messageEnvelopeVersion` / major bump.
3. **AEAD и AAD.** Подмена метаданных ломает расшифровку.
4. **Минимизация доверия к серверу.** Сервер маршрутизирует ciphertext, не читает историю.
5. **Проверяемость.** Норма сопоставима с golden-векторами и server-side validation.
6. **Честные ограничения v1.** `preKeyId = null`, без Double Ratchet — допустимый MVP.
7. **Восстановление и чат ортогональны.** После recovery участники снова устанавливают канал с актуальными device keys.
8. **Метаданные вне ciphertext.** Частота, размеры, id бесед — residual risk; минимизируется продуктовой политикой.

---

## Cryptographic primitives

Production stack для **сообщений** FSCP v1:

| Назначение | Примитив |
| --- | --- |
| Device agreement | X25519 |
| KDF (RKE unwrap) | HKDF RFC 5869, SHA-256 |
| AEAD (тело и RKE) | XChaCha20-Poly1305 **IETF** (libsodium), nonce 24 байта |
| Подпись envelope | Ed25519 (sender device signing key) |
| Fingerprint | SHA-256 |
| Random | CSPRNG (WebCrypto / libsodium) |

Для v1 **запрещён** fallback на AES-GCM. Password/recovery KDF (Argon2id) — в [`e2e-security.md`](./e2e-security.md).

**Версии payload (v1):**

- `fscpProtocolVersion = 1`
- `messageEnvelopeVersion = 1` (поле `version` в JSON)
- `e2eProtocolVersion = 1`

---

## Wire format

HTTP/API передаёт сообщение как строку с префиксом **`fscp1:`**, за которым следует **base64url без padding** внутреннего JSON envelope.

```
fscp1:<base64url(UTF-8 JSON MessageEnvelope)>
```

**Инварианты v1 (1:1):**

- Внутри JSON: `version = 1`, `keyEpochId` = bootstrap epoch (см. ниже), `recipients` — ровно **2** элемента (оба участника DM).
- Для одного сообщения на wire **оба** поля legacy API (`encryptedForReceiver`, `encryptedForSender`) должны содержать **одинаковую** строку `fscp1:…`.
- `senderUserUuid` в wire совпадает с аутентифицированным отправителем.
- `conversationUuid` = детерминированный UUID DM из пары участников (UUIDv5).

**Bootstrap constants (текущая реализация v1):**

| Константа | Значение |
| --- | --- |
| `FSCP_BOOTSTRAP_KEY_EPOCH_ID` | `00000000-0000-4000-8000-000000000001` |
| `FSCP_BOOTSTRAP_DEVICE_UUID` | `00000000-0000-4000-8000-000000000002` (sentinel, пока нет per-device UUID на сервере) |

---

## MessageEnvelope

Внутренний JSON (до кодирования в `fscp1:`):

```json
{
  "version": 1,
  "messageUuid": "uuid",
  "conversationUuid": "uuid",
  "keyEpochId": "uuid",
  "senderUserUuid": "uuid",
  "senderDeviceUuid": "uuid",
  "messageKeyId": "uuid-or-counter",
  "createdAt": "utc-iso8601",
  "ciphertextBase64Url": "...",
  "aead": {
    "name": "xchacha20-poly1305",
    "nonceBase64Url": "..."
  },
  "recipients": [
    {
      "userUuid": "uuid",
      "deviceUuid": "uuid",
      "recipientKeyEnvelope": {
        "version": 1,
        "algorithm": "x25519-hkdf-xchacha20poly1305",
        "ephemeralPublicKeyBase64Url": "...",
        "recipientAgreementPublicKeyId": "uuid",
        "preKeyId": null,
        "saltBase64Url": "...",
        "aead": { "name": "xchacha20-poly1305", "nonceBase64Url": "..." },
        "ciphertextBase64Url": "..."
      }
    }
  ],
  "senderSigningPublicKeyBase64Url": "...",
  "senderSignatureBase64Url": "..."
}
```

**Plaintext тела сообщения** (до AEAD) — блочная схема (соответствует реализации [`envelope.ts`](../../Products/FSCP/ts/src/envelope.ts) в `@flora/fscp`):

```json
{
  "type": "blocks",
  "version": 1,
  "blocks": [
    { "kind": "text", "body": "message text" }
  ],
  "clientCreatedAt": "utc-iso8601",
  "replyTo": {
    "messageUuid": "uuid",
    "authorDisplayName": "string",
    "preview": "string"
  }
}
```

- `blocks[]` — упорядоченный список; `kind ∈ { text, voice, image, video }`. Неизвестный `kind` получатель **сохраняет** как placeholder-блок (не выбрасывает молча): без этого старый клиент показал бы сообщение нового типа как пустое (v1.0-errata-5, forward-compat).
- Медиа-блоки (`voice`/`image`/`video`) **не** несут байты в plaintext: они содержат `assetUuid` и `encryption { algorithm: "aes-gcm", keyBase64Url, nonceBase64Url }`; сам ассет шифруется отдельным file key и грузится как encrypted object (см. [`e2e-security.md`](./e2e-security.md) §Размерные лимиты — attachment descriptor). `messageKey` беседы **не** переиспользуется как file key.
- `replyTo` опционален (денормализованный превью реплая).
- **Read-compat:** получатель обязан принимать legacy-форму `{ "type": "text", "body": "…", "clientCreatedAt": "…" }` и нормализовать её в единственный `text`-блок. Отправитель v1.0-errata-1 пишет только блочную форму.
- **Паддинг длины (v1.0-errata-5):** перед AEAD compact-JSON plaintext дополняется top-level полем `"pad": "00…0"` до фиксированных бакетов — шаг 256 Б до 4 КиБ, дальше шаг 1 КиБ (`padPlaintextJsonV1` / `fscpPlaintextBucketBytes` в `@flora/fscp`). Серверу и наблюдателю канала утекает только номер бакета, а не точная длина сообщения. Получатель игнорирует `pad` как неизвестное top-level поле — паддинг read-compatible со старыми читателями и **не** меняет байты конверта.

Plaintext тела — **внутри** AEAD, сервер его не видит; поэтому эволюция схемы блоков (включая `pad`) не является wire-breaking, пока не меняются поля AAD ниже.

**AAD тела сообщения:**

```text
flora.messaging.message.v1 | conversationUuid | keyEpochId | messageUuid | messageKeyId | senderUserUuid | senderDeviceUuid | createdAt
```

UUID в AAD — **нижний регистр**. Разделитель полей — ` | ` (U+007C).

**AAD recipient key envelope:**

```text
flora.messaging.recipient-key-envelope.v1 | conversationUuid | keyEpochId | messageUuid | messageKeyId | senderUserUuid | senderDeviceUuid | recipientUserUuid | recipientDeviceUuid | recipientAgreementPublicKeyId
```

Тело шифруется случайным 32-байтовым `messageKey` (CSPRNG). `recipientKeyEnvelope.ciphertextBase64Url` содержит тот же `messageKey`, зашифрованный per-device.

`preKeyId` в v1 **обязан** быть `null`; непустое значение сервер отклоняет.

Сервер **не принимает** plaintext `content` для новых сообщений v1.

---

## Key agreement v1 (recipientKeyEnvelope)

Алгоритм `x25519-hkdf-xchacha20poly1305` выполняется **независимо для каждой** строки `recipients[]`.

1. **Ephemeral:** новая пара X25519 на каждый RKE; `ephemeralPublicKeyBase64Url` — 32 байта. **Запрещено** повторное использование ephemeral для другого `messageUuid` или другой строки `recipients[]`.
2. **Shared secret:** `ss = X25519(ephemeral_private, recipient_agreement_public)` (отправитель); получатель — `X25519(recipient_private, ephemeral_public)`.
3. **HKDF:** `PRK = HKDF-Extract(SHA-256, salt=decode(saltBase64Url), IKM=ss)`; `wrapKey = HKDF-Expand(PRK, info=UTF8(AAD_recipient_line), L=32)`. Соль — 32 случайных байта, уникальная для envelope.
4. **AEAD:** XChaCha20-Poly1305 IETF, ключ `wrapKey`, nonce 24 байта, AAD = та же строка `AAD_recipient_line`. Plaintext AEAD — **ровно 32 байта** `messageKey`.

**Инвариант:** нет «одного ephemeral на всю беседу». Общность — один `messageKey` в ciphertext тела и согласованные поля AAD.

`recipientAgreementPublicKeyId` — uuid опубликованного agreement public key получателя (`UserDeviceKey` в scope `keyEpochId`).

**Подпись envelope:**

```text
flora.messaging.envelope-signature.v1 | canonicalEnvelopeWithoutSignature
```

Подпись Ed25519 покрывает весь `recipients` array. Сервер не может незаметно удалить получателя или подменить RKE без нарушения подписи (клиент проверяет; сервер в v1 проверяет **форму**, см. §Known limitations). `canonicalEnvelopeWithoutSignature` — canonical JSON конверта (§Canonical encoding) со всеми полями **кроме** `senderSignatureBase64Url`; поле `senderSigningPublicKeyBase64Url` **входит** в подписываемый объект.

Golden: [`test-vectors/fscp-rke-wrap-key-v1.json`](../test-vectors/fscp-rke-wrap-key-v1.json).

---

## Algorithms (v1) — нормативные шаги

Псевдокод ниже — обязательная последовательность; байты (§MessageEnvelope, §Key agreement, §Canonical encoding) не переопределяются, только фиксируется порядок для паритета имплементаций. `b64u` — base64url без padding.

### A. Отправитель — сборка wire (`buildFscpWireEnvelope`)

```text
Вход: senderUserUuid, receiverUserUuid,
      senderAgreementPrivKey (X25519), senderSigningPrivKey (Ed25519 seed/keypair),
      receiverAgreementPubKey (X25519), plaintext (блочная схема)

 1. messageUuid   ← UUIDv7 (CSPRNG)
    messageKeyId  ← UUIDv7 (CSPRNG)          # в v1 — uuid, не счётчик
    createdAt     ← now() в ISO-8601 UTC
    keyEpochId    ← FSCP_BOOTSTRAP_KEY_EPOCH_ID
    conversationUuid ← UUIDv5(ns, "{min}|{max}|fscp-dm-v1")   # см. §4.2 next-architecture
    senderDeviceUuid = receiverDeviceUuid = FSCP_BOOTSTRAP_DEVICE_UUID
 2. messageKey    ← 32 случайных байта (CSPRNG)
 3. bodyAad       ← messageBodyAadLine(...)  # UTF-8, UUID в нижнем регистре
    bodyNonce     ← 24 случайных байта
    padded        ← padPlaintextJsonV1(JSON(plaintext))   # errata-5: бакеты длины, поле "pad"
    bodyCipher    ← XChaCha20Poly1305-IETF.enc(messageKey, nonce=bodyNonce, aad=UTF8(bodyAad), pt=UTF8(padded))
 4. Для каждого получателя R ∈ { receiver, sender } (self-copy обязателен для чтения своей истории):
      rkeAad      ← recipientKeyEnvelopeAadLine(..., recipientAgreementPublicKeyId=UUIDv5(R.user, keyEpoch))
      ephSecret   ← 32 случайных байта;  ephPub ← X25519.base(ephSecret)   # НОВЫЙ ephemeral на каждый R
      salt        ← 32 случайных байта
      ss          ← X25519(ephSecret, R.agreementPub)
      prk         ← HKDF-Extract(SHA-256, salt, ss)
      wrapKey     ← HKDF-Expand(prk, info=UTF8(rkeAad), L=32)
      rkeNonce    ← 24 случайных байта
      rkeCipher   ← XChaCha20Poly1305-IETF.enc(wrapKey, nonce=rkeNonce, aad=UTF8(rkeAad), pt=messageKey)
      → recipient entry { userUuid, deviceUuid, recipientKeyEnvelope{ version:1, algorithm, ephPub, recipientAgreementPublicKeyId, preKeyId:null, salt, aead{nonce}, rkeCipher } }
 5. recipients ← sort(entries) по (userUuid, deviceUuid) в нижнем регистре
 6. envelopeNoSig ← { version:1, messageUuid, conversationUuid, keyEpochId, senderUserUuid,
                      senderDeviceUuid, messageKeyId, createdAt, ciphertextBase64Url=b64u(bodyCipher),
                      aead{name, nonce=b64u(bodyNonce)}, recipients, senderSigningPublicKeyBase64Url=b64u(signPub) }
 7. sig ← Ed25519.sign(senderSigningPrivKey, UTF8("flora.messaging.envelope-signature.v1 | " + canonicalJson(envelopeNoSig)))
 8. full ← envelopeNoSig ∪ { senderSignatureBase64Url = b64u(sig) }
 9. wire ← "fscp1:" + b64u(UTF8(JSON(full)))
```

**Инварианты отправителя:** новый `messageKey`, новый ephemeral и новый nonce на **каждое сообщение** и **каждую строку** `recipients` (запрет reuse). Никогда не отправлять plaintext `content` для v1.

### B. Получатель — открытие wire (`decryptFscpWireEnvelope`)

```text
Вход: wire, viewerUserUuid, viewerAgreementPrivKey

 1. Проверить префикс "fscp1:"; env ← JSON(b64u_decode(остаток))
 2. Проверить подпись (§Signature authenticity):
    Ed25519.verify(pk, sig, UTF8("flora.messaging.envelope-signature.v1 | " + canonicalJson(env без senderSignatureBase64Url)));
    при провале — ОТКЛОНИТЬ. Конверт БЕЗ senderSigningPublicKeyBase64Url — ОТКЛОНИТЬ
    (v1.0-errata-5, downgrade-защита); чтение доархивных сообщений — только через явную
    опцию allowUnsignedLegacy (текущий трафик такие wire не проходит и на сервере).
 3. row ← recipients.find(userUuid == viewerUserUuid);  нет → ошибка «нет RKE»
 4. rkeAad ← recipientKeyEnvelopeAadLine(env-поля, row.userUuid, row.deviceUuid, row.recipientAgreementPublicKeyId)
    ss   ← X25519(viewerAgreementPrivKey, row.ephPub)
    prk  ← HKDF-Extract(SHA-256, row.salt, ss);  wrapKey ← HKDF-Expand(prk, info=UTF8(rkeAad), L=32)
    messageKey ← XChaCha20Poly1305-IETF.dec(wrapKey, row.nonce, aad=UTF8(rkeAad), ct=row.rkeCipher)   # 32 байта
 5. bodyAad ← messageBodyAadLine(env-поля)
    pt ← XChaCha20Poly1305-IETF.dec(messageKey, env.aead.nonce, aad=UTF8(bodyAad), ct=env.ciphertext)
 6. Нормализовать plaintext (принять legacy text-форму), вернуть блоки.
```

Любое несовпадение AAD (подмена `conversationUuid`/`messageUuid`/`messageKeyId`/`senderDeviceUuid`/…) ломает AEAD-tag → decrypt падает. Это и есть защита целостности метаданных.

### C. Сервер — структурная валидация (без расшифровки)

Нормативный порядок (реализация — [`Products/FSCP/crates/fscp-core/src/lib.rs`](../../Products/FSCP/crates/fscp-core/src/lib.rs), `try_validate_dual_wire`; форма и строки ошибок заморожены — [`next-architecture.md`](../../next-architecture.md) §4.4):

```text
 1. dual-wire: encryptedForReceiver == encryptedForSender (Ordinal)     # legacy-мост, см. §Known limitations
 2. непусто; длина ≤ 200 000 символов; префикс "fscp1:"
 3. base64url → inner JSON ≤ 120 000 байт; корень — объект
 4. version == 1
 5. senderUserUuid == аутентифицированный отправитель
 6. conversationUuid == UUIDv5(sender, receiver)     # DM deterministic
 7. keyEpochId == bootstrap epoch v1
 8. recipients: массив ровно из 2 объектов; множество userUuid == { sender, receiver }
 9. для каждого recipient: валидный deviceUuid; recipientKeyEnvelope.version==1;
    algorithm=="x25519-hkdf-xchacha20poly1305"; preKeyId==null;
    recipientAgreementPublicKeyId == UUIDv5(recipient.user, keyEpoch)   # ← проверяется сервером (errata: было недокументировано)
    |ephemeral|==32 B, |salt|==32 B, |rkeNonce|==24 B, |rkeCipher|≥16 B
10. |bodyCipher|≥16 B и ≤ 64 KiB; body aead.name=="xchacha20-poly1305"; |bodyNonce|==24 B
11. senderSigningPublicKeyBase64Url присутствует, |pk|==32 B; senderSignatureBase64Url присутствует, |sig|==64 B
    # шаги 1–11: только ФОРМА, строки ошибок заморожены (golden fscp_wire_validator_v1)
12. verify_envelope_signature(wire)   # v1.0-errata-5, defense-in-depth ПОСЛЕ замороженного валидатора:
    # Ed25519.verify(pk, sig, "flora.messaging.envelope-signature.v1 | " + canonicalJson(env без подписи))
    # содержимое НЕ расшифровывается; отклоняется конверт с порченой/подделанной подписью
```

Сервер **не** проверяет: порядок сортировки `recipients`, значение `createdAt`, содержимое ciphertext. Криптопроверка подписи на сервере (шаг 12) — защита хранилища от мусора и подделок, но **не** замена клиентской верификации: аутентичность против активного сервера по-прежнему обеспечивает только клиент (§Signature authenticity).

### Signature authenticity (v1) — точная модель и ограничение

Подпись Ed25519 в v1 обеспечивает **целостность** конверта, но **не** аутентичность против активного сервера, потому что получатель проверяет её ключом `senderSigningPublicKeyBase64Url`, **встроенным в тот же конверт**, а не доверенным epoch account identity / device signing key. Следствия, нормативно:

- **Получатель ОБЯЗАН** верифицировать подпись; несовпадение → отклонить сообщение. Конверт **без** `senderSigningPublicKeyBase64Url` отклоняется **по умолчанию** (v1.0-errata-5: ранее `verifyDetachedEnvelopeSignature` молча пропускал проверку — downgrade-окно, FSCP-REVIEW п.1). Чтение доархивных неподписанных сообщений — только через явную opt-in-опцию `allowUnsignedLegacy` при вызове `decryptFscpWireEnvelope`; для текущего трафика такие wire отклоняет и сервер (форма, шаг 11).
- **Отправитель:** при сборке конверта отсутствие валидного signing-ключа — **ошибка**, а не повод сгенерировать одноразовый случайный ключ (v1.0-errata-5, устранён fallback FSCP-REVIEW п.2: подпись случайным ключом создаёт ложное чувство аутентичности и ломает будущий device-key binding).
- **Гарантия v1:** «тот, кто собрал конверт, им же и подписал» + защита метаданных через AAD. Это защищает от пассивной утечки БД и модификации в хранилище.
- **Чего v1 НЕ даёт:** злонамеренный или скомпрометированный сервер может подменить пару (pk, подпись) и RKE. Закрывается только связкой device key ← подписан epoch account identity (см. [`e2e-security.md`](./e2e-security.md) §Подлинность ключей п.1) + safety number OOB-сверкой (§Safety number) + key transparency (phase 2). До этого — E2E полезен, но не полон против активной атаки сервера (честно зафиксировано в [`e2e-security.md`](./e2e-security.md) §Частично защищаемся от).
- **Defense-in-depth (v1.0-errata-5, выполнено):** сервер криптографически верифицирует Ed25519-подпись конверта (`fscp_core::verify_envelope_signature`, Algorithm C шаг 12) **после** замороженного структурного валидатора. Это отсекает порченые/подделанные конверты до записи в хранилище, но не даёт аутентичности против самого сервера (ключ — из конверта).

---

## Session state (1:1)

Для пары `(conversationUuid, keyEpochId)` клиент ведёт **`FscpV1ConversationSession`** (память / локальное хранилище — вне нормы wire).

| `sessionState` | Условие | Поведение |
| --- | --- | --- |
| `uninitialized` | Нет успешно обработанного envelope для пары | Отправитель может отправить первое сообщение; получатель после decrypt → `ready` |
| `ready` | Хотя бы одно сообщение успешно обработано | Обычный обмен |
| `compromised_local` | Revoke устройства, смена epoch identity, reset в UI, **подряд идущие** key-mismatch-сбои decrypt (порог 3, v1.0-errata-5) | Исходящие приостановлены до re-handshake |

| Поле | Назначение |
| --- | --- |
| `conversationUuid`, `keyEpochId`, `peerUserUuid` | Идентификаторы |
| `fscpProtocolVersion` | `1` |
| `lastProcessedInboundMessageUuid` | Опционально, anti-duplicate UX |
| `lastAcceptedOutboundMessageUuid` | Опционально |

**Wire vs состояние:** на каждое сообщение — новый ephemeral и новый `messageKey` per RKE. `ready` означает доверие к каналу, а не долгоживущий shared secret на wire.

**Классификация сбоев decrypt (v1.0-errata-5, анти-DoS).** Ранее любой сбой decrypt немедленно переводил сессию в `compromised_local` — собеседник (или сервер) мог заморозить исходящие жертвы одним мусорным конвертом (FSCP-REVIEW п.3). Теперь сбои типизированы (`FscpDecryptFailureCategory`) и делятся на два класса воздействия:

- `envelope_rejected` — `not_fscp_wire`, `malformed_envelope`, `signature_missing`, `signature_invalid`, `no_recipient_entry`, `malformed_plaintext`: конверт отклонён по форме/подписи, атрибутируемо отправителю/транспорту — **сессию не трогает**;
- `key_mismatch_suspect` — `rke_unwrap_failed`, `body_decrypt_failed`: криптосбой при корректном конверте, свидетельство рассинхронизации ключей — накапливается, и только `FSCP_DECRYPT_COMPROMISE_THRESHOLD = 3` **подряд** идущих сбоя переводят в `compromised_local`; любой успешный decrypt сбрасывает счётчик.

Референсная реализация — [`conversationSession.ts`](../../Products/FSCP/ts/src/conversationSession.ts) (`@flora/fscp`, реэкспорт через `@flora/client-core/fscp`): чистая FSM без I/O (переносима Web/Mobile/Rust), переходы, классификация сбоев и триггеры `compromised_local` покрыты unit-тестами; интеграция в UI-поток сообщений — при подключении safety number surface.

---

## Safety number (fingerprint)

**Цель:** два клиента при одинаковых входах вычисляют одинаковый `fingerprintSha256Hex` для OOB-сверки.

**Входы:** `keyEpochId`, `conversationUuid`, два Ed25519 epoch account identity public key (32 байта) участников.

**Упорядочивание:** `pk_low`, `pk_high` — сортировка 32-байтовых ключей по memcmp.

**Preimage (UTF-8, без BOM):**

```text
flora.fscp.v1.safety-number|<keyEpochId>|<conversationUuid>|<pkLowB64u>|<pkHighB64u>
```

**Выход:** `fingerprintSha256Hex` = lowercase hex SHA-256(preimage), 64 символа.

Golden: [`test-vectors/fingerprint-v1.json`](../test-vectors/fingerprint-v1.json).

**Phase 1 (до key transparency):**

- Safety number обязателен в UI 1:1 после перехода в `ready`.
- `verified contact` — локальный флаг на клиенте, не на сервере.
- Смена epoch identity сбрасывает verified state.

---

## Canonical encoding

Для подписей и AAD:

- canonical JSON с сортировкой ключей объекта;
- **порядок сортировки ключей — по значению UTF-16 code unit (эквивалент побайтового для ASCII-имён полей v1)**. Реализация использует `Array.prototype.sort` без коллатора (`localeCompare` для не-ASCII ключей не эквивалентен и запрещён к использованию в новых имплементациях, включая Rust — сортировать по кодовым единицам/байтам). В v1 все имена полей ASCII, поэтому code-unit и байтовый порядок совпадают; правило зафиксировано для будущего паритета кросс-язык;
- вложенные массивы сериализуются рекурсивно **в исходном порядке элементов** (canonical не переупорядочивает массивы);
- UTF-8 без BOM;
- base64url **без padding**;
- даты ISO-8601 UTC;
- массив `recipients` сортируется отправителем по `(userUuid, deviceUuid)` в нижнем регистре **до** подписи; сервер проверяет **состав** получателей, но **не** переупорядочивание (порядок закрепляется подписью клиента);
- неизвестные поля в strict mode → ошибка.

**Canonicalization malleability (известное ограничение v1, FSCP-REVIEW п.4).** Подпись покрывает **canonical-форму** конверта, а не байты wire: получатель пересобирает `canonicalJson` из распарсенного JSON, поэтому два разных wire-представления одного конверта (порядок ключей, эквивалентные записи чисел вроде `1e2` vs `100`) дают одну и ту же подпись. Для v1 это безвредно — все смысловые поля дополнительно связаны AAD, а серверная криптопроверка (Algorithm C шаг 12) отклоняет конверты с несходящейся подписью до записи в хранилище. Новые имплементации (в т.ч. Rust client-core) обязаны: отклонять дубликаты ключей при парсинге, не «нормализовывать» числа и строки при пересборке canonical. Полная фиксация «подпись поверх байтов wire» — кандидат в v2 (несовместимо с v1).

Golden-паритет canonical/AAD между `Apps/Web/lib/fscp` и `@flora/fscp` (`Products/FSCP/ts`) — обязателен (см. §Test vectors, требование о consumer-тесте).

**Nonce rules:**

- XChaCha20-Poly1305: nonce 192-bit, CSPRNG;
- один nonce не повторяется с тем же ключом;
- для RKE уникальность через пару `(ephemeral, nonce)` и полный AAD context.

---

## NotificationPreviewEnvelope v1

`NotificationPreviewEnvelope` — отдельный компактный wire для native push-preview, не
`MessageEnvelope` и не plaintext `pushPreview`.

- Префикс: `fscpnp1:`.
- Получатель: одна installation-specific X25519 public key, зарегистрированная вместе
  с push capability; private key никогда не передаётся JS/server/provider.
- Plaintext: `{ "preview": string, "kind": "text|photo|voice|video|mixed", "pad": string }`,
  максимум 120 Unicode code points; UTF-8 JSON дополняется пробелами в `pad` до
  одного из бакетов 128/256/512/768 bytes.
- KEM/AEAD: ephemeral X25519 → HKDF-SHA256(salt 32 B, info=AAD) →
  XChaCha20-Poly1305 (nonce 24 B).
- AAD:

```text
flora.notifications.message-preview.v1 | previewId | wireMessageUuid |
wireSha256Base64Url | conversationUuid | senderUserUuid | recipientUserUuid |
recipientInstallationUuid | previewKeyId | issuedAt | expiresAt
```

- Подпись: Ed25519 sender signing key основного message wire над
  `flora.notifications.message-preview-signature.v1 | canonicalJson(envelopeWithoutSignature)`.
- Native проверяет self-contained подпись, но без основного wire не усиливает
  аутентичность сверх текущей FSCP v1 active-server threat model; обязательное
  сравнение sender key с message wire выполняет Messaging до маршрутизации.
- `wireSha256Base64Url = b64u(SHA-256(exact UTF-8 fscp1 wire))`; сервер сверяет digest,
  `wireMessageUuid`, conversation, users и sender signing public key с основным wire.
- Максимальный TTL — 24 часа; максимальный `fscpnp1` wire — 2700 UTF-8 bytes.
- Envelope advisory: неверный/stale/oversized target отбрасывается, но message send
  продолжается с generic push. Полный ciphertext не логируется и долгосрочно не хранится.

## Server-side validation

Сервер **не расшифровывает** E2E payload, но обязан валидировать форму (реализация: `fscp_core::try_validate_dual_wire`, [`Products/FSCP/crates/fscp-core`](../../Products/FSCP/crates/fscp-core/src/lib.rs)).

**Обязательные проверки wire v1:**

- при dual-wire API — `encryptedForReceiver` и `encryptedForSender` **побайтово равны** (Ordinal);
- префикс `fscp1:`;
- `version = 1`;
- `senderUserUuid` = текущий пользователь;
- `conversationUuid` соответствует участникам DM (`UUIDv5(sender, receiver)`);
- `keyEpochId` = bootstrap epoch v1;
- `recipients` — массив из **2** элементов, оба участника присутствуют;
- у каждого recipient: `deviceUuid`, `recipientKeyEnvelope` с `algorithm = x25519-hkdf-xchacha20poly1305`, `preKeyId = null`;
- `recipientAgreementPublicKeyId = UUIDv5(recipient.userUuid, keyEpochId)` — сервер **проверяет** соответствие id пользователю и эпохе;
- размеры ephemeral (32 B), salt (32 B), nonce RKE (24 B), ciphertext RKE (≥16 B), body ciphertext (≥16 B);
- `senderSigningPublicKeyBase64Url` (32 B), `senderSignatureBase64Url` (64 B) — **форма** (строки ошибок заморожены);
- **криптопроверка Ed25519** (v1.0-errata-5, defense-in-depth): `fscp_core::verify_envelope_signature` — после структурного валидатора, без расшифровки содержимого; не заменяет клиентскую верификацию (§Signature authenticity).

Полная нормативная последовательность — §Algorithms (v1) → C. Сервер.

**Размерные лимиты:**

| Объект | Лимит |
| --- | --- |
| Текст до шифрования | 20 KiB |
| Encrypted message body | 64 KiB |
| Один recipient envelope | 8 KiB |
| FSCP wire string | 200 000 символов |
| Inner JSON UTF-8 | 120 000 байт |

Сервер не логирует ciphertext целиком.

---

## Forward secrecy: MVP vs target

| Уровень | Поведение | FS | PCS |
| --- | --- | --- | --- |
| **MVP v1** | Новый `messageKey` и ephemeral **на каждое** сообщение; сессия сбрасывается по `compromised_local`, смене epoch, reset UI | частично¹ | нет |
| **v1.1** | + one-time pre-keys (сильнее защита первого сообщения) | частично¹ | нет |
| **v2 (target)** | X3DH + Double Ratchet: симметричный+DH ratchet, per-message keys | да | да |

¹ v1 даёт **эфемерность на уровне RKE-обёртки** (компрометация приватного agreement-ключа получателя раскрывает все `messageKey`, зашифрованные на него, т.к. long-term agreement key переиспользуется). Настоящая forward secrecy между сообщениями появляется только с ratchet (v2). Это честное ограничение MVP.

**Критерий включения ratchet (v2):** security review + transcript test vectors + обратная совместимость **чтения** v1 (старая история остаётся читаемой) + отдельная major-версия `messageEnvelopeVersion = 2`.

---

## Целевой алгоритм (roadmap, не входит в замороженный v1 wire)

Раздел нормативен как **план**. Pre-keys и v2 активируются только явным bump версии. Wire-дельта franking **реализована в коде**, но эмиссия тега выключена (`emitFrankTag` off) — байты v1 не меняются, пока не пройдена ступень 3 [`franking.md`](./franking.md) §Активация и не снята заморозка wire ([`next-architecture.md`](../../next-architecture.md) §1.2). Остальное ниже (pre-keys, ratchet, PQ в продакшене) по-прежнему **после** bump'а.

### v1.1 — one-time pre-keys (roadmap; не текущий wire)

Цель: убрать переиспользование long-term agreement key как единственного секрета RKE, не вводя полный ratchet. Это **не** единственная дельта под меткой 1.1: franking уже занимает `fscpProtocolVersion = 1.1` при `preKeyId = null` (§Versioning, golden `fscp_franking_wire_v1_1`).

- Устройство публикует на сервере пул **one-time pre-keys** (X25519), каждый — с `preKeyId` (uuid) и подписью epoch account identity key. Сервер раздаёт по одному и **удаляет выданный** (at-most-once); при исчерпании — fallback на signed pre-key.
- Отправитель в RKE использует `ss = X25519(ephemeral, oneTimePreKey_recipient)` вместо long-term agreement key; `preKeyId != null` указывает, какой pre-key был использован.
- Wire-дельта **этого** подраздела: `preKeyId` перестаёт быть `null`. Не путать с franking (`frankTag` / AAD `message.v1_1`, `preKeyId` остаётся `null`). Сервер при активации pre-keys снимает проверку «`preKeyId == null`» и добавляет «pre-key существует/не израсходован».
- Совместимость: bump `messageEnvelopeVersion` **не** обязателен (аддитивно). Новые golden обязательны; не переиспользовать exclusive «1.1 = только pre-keys». Клиент без pre-keys читать такие конверты не обязан (разные epoch).

### v2 — X3DH + Double Ratchet (полный target)

**Установление сессии (X3DH-подобно):** между устройствами A и B по опубликованным `(identityKey, signedPreKey, oneTimePreKey)`:

```text
DH1 = X25519(IK_A, SPK_B)
DH2 = X25519(EK_A, IK_B)
DH3 = X25519(EK_A, SPK_B)
DH4 = X25519(EK_A, OPK_B)          # если one-time pre-key доступен
SK  = HKDF(DH1 ‖ DH2 ‖ DH3 ‖ DH4)  # root key начальной сессии
```

**Обмен сообщениями (Double Ratchet):**

- **Symmetric-key ratchet:** из chain key выводится per-message `messageKey` (`KDF_CK`), chain key продвигается — каждый ключ используется один раз (FS).
- **DH ratchet:** при смене направления стороны обмениваются новыми ephemeral DH public (в заголовке сообщения), root key продвигается (`KDF_RK`) — даёт post-compromise security.
- **Заголовок сообщения:** `dhPublic`, `previousChainLength (PN)`, `messageNumber (N)` для доставки out-of-order и skipped-message keys (буфер с лимитом).

**Отображение на wire v2 (эскиз, отдельная спецификация):** `MessageEnvelope.version = 2`; `recipientKeyEnvelope` заменяется на `ratchetHeader { dhPublicBase64Url, pn, n }` + `messageKeyId`, ассоциированный с ratchet-шагом; AAD-строки получают суффикс `.v2` и включают `dhPublic`, `pn`, `n`. Тело по-прежнему XChaCha20-Poly1305 IETF под per-message key.

**Инварианты миграции v1→v2:**

- старая история v1 остаётся читаемой (клиент выбирает путь по `keyEpochId`/`version`);
- нельзя понижать версию беседы (см. [`e2e-security.md`](./e2e-security.md) §Rollback policy);
- новые golden transcript-векторы (`Documents/test-vectors/`, регенерация из эталонной реализации — руками не править, [`AGENTS.md`](../../AGENTS.md)).

### Post-quantum (v2+, нормативное направление)

Актуальная угроза уже для v1 — **harvest-now-decrypt-later**: адверсарий записывает ciphertext сегодня и расшифровывает после появления криптографически значимого квантового компьютера. Для долгоживущей личной переписки это главный PQ-риск; подпись/аутентификация, напротив, требует атаки в реальном времени и мигрирует позже.

Нормативные решения:

1. **Гибрид, не замена.** Key agreement переводится на **X25519 + ML-KEM-768** (FIPS 203): `ss = KDF(ss_x25519 ‖ ss_mlkem ‖ transcript)`. Чистый PQ-KEM без классической компоненты запрещён — молодые схемы не имеют сопоставимой истории криптоанализа; взлом любой из двух компонент не раскрывает сессию.
2. **Точки внедрения.** v1.1 pre-key bundle расширяется до пары (X25519 pre-key, ML-KEM encapsulation key), обе подписаны epoch identity; X3DH v2 выполняется по PQXDH-схеме (референс: Signal PQXDH — ML-KEM закрывает initial handshake). PQ-укрепление самого ratchet (направление Signal SPQR / triple ratchet) — отдельное решение после стабилизации, DH-шаги ratchet до тех пор классические.
3. **Подписи.** Ed25519 остаётся для аутентификации; миграция на ML-DSA (FIPS 204) — отдельный milestone после вызревания экосистемы (размер подписи ≥ 2420 B против 64 B — цена, не оправданная моделью угроз аутентификации сегодня).
4. **Размеры и wire.** ML-KEM-768: encapsulation key 1184 B, ciphertext 1088 B — RKE-лимит 8 KiB выдерживает гибрид с запасом; растёт только RKE, тело сообщения не меняется (XChaCha20-Poly1305 — symmetric, PQ-стойкость при 256-битном ключе достаточна).
5. **Gate.** Активация — вместе с major bump v2: KAT-векторы FIPS 203 + собственные гибридные транскрипт-векторы (та же дисциплина потребления, §Test vectors) + внешний криптоаудит гибридного KDF.

**Прототип комбинера (выполнено, v2-draft).** Конкретная инстанциация формулы п. 1, закреплённая golden-вектором `fscp_hybrid_kem_v2draft_v1` (§Test vectors) с тремя независимыми реализациями ML-KEM (kyber-py ↔ @noble/post-quantum ↔ RustCrypto `ml-kem`); в продакшн-код не входит до v2 design review:

```
ss_x25519            = X25519(eph_priv, recipient_agreement_pub)
(ss_mlkem, ct_mlkem) = ML-KEM-768.Encaps(recipient_ek)
transcriptHash       = SHA-256(utf8("flora.fscp.v2draft.hybrid-transcript")
                               ‖ eph_pub(32) ‖ recipient_agreement_pub(32)
                               ‖ recipient_ek(1184) ‖ ct_mlkem(1088))
aadLine              = "flora.messaging.recipient-key-envelope.v2draft | <10 uuid-полей v1
                        + recipientMlKemEncapsulationKeyId> | pq:" + base64url(transcriptHash)
wrapKey              = HKDF-SHA-256(salt = salt32,
                                    IKM  = ss_x25519 ‖ ss_mlkem,   // классическая компонента первая
                                    info = utf8(aadLine), L = 32)
RKE ciphertext       = XChaCha20-Poly1305(wrapKey, nonce24, messageKey32, aad = utf8(aadLine))
```

Свойства: `transcript` из формулы п. 1 реализован как SHA-256-хэш всех публичных значений обмена **внутри** HKDF-info (через AAD) — подмена любого из `eph_pub`/`ek`/`ct` меняет ключ и AAD одновременно; IND-CCA обеспечивается уже тем, что обе компоненты входят в IKM, а FIPS 203 implicit rejection (`K̄ = J(z‖c)`) при подменённом `ct_mlkem` детерминированно уводит получателя на другой `wrapKey` — AEAD не открывается (закреплено негативами вектора). Порядок IKM фиксирован: классика первая, PQ вторая.

### Group messaging (за пределами v2)

MLS или sender keys — отдельная спецификация. Не смешивать с 1:1 сессией.

### Message franking (модерация E2E без раскрытия истории)

Единственный санкционированный FGP канал модерации приватной переписки ([`../fgp/FGP.md`](../fgp/FGP.md) §6.5; обязательное клиентское сканирование запрещено конституционно, FGP §1.2 п. 7). Схема (target; боевая эмиссия тега — ступень 3 [`franking.md`](./franking.md) §Активация, не вместе с pre-keys):

1. **Commit при отправке:** отправитель включает franking-тег `frankTag = HMAC-SHA-256(frankingKey, commitInput)`, где `frankingKey` — случайный per-message ключ, передаётся получателю **внутри** зашифрованного тела (сервер его не видит), а `commitInput` детерминированно собирается из контекста сообщения и `SHA-256(plaintext)`.
2. **Слепая квитанция:** сервер подписывает `receiptPayload(frankTag, messageUuid, участники, ts)` **не видя** plaintext (видит только `frankTag`), и прикладывает к доставке.
3. **Добровольная жалоба:** получатель раскрывает жюри `plaintext`, `frankingKey`, `frankTag`, `serverFrankReceipt`. Жюри проверяет HMAC и подпись сервера → доказательство «это сообщение реально отправлено этим отправителем через этот сервер», **без** доступа к остальной переписке.
4. **Приватность:** подделка жалобы криптографически исключена (HMAC binding + committing-конструкция поверх не-committing AEAD); сервер не может сам инициировать раскрытие; непожалованные сообщения не раскрываются.

Статус: **RFC-draft принят и исполняем** — полная спецификация (байтовые форматы `commitInput`/`receiptPayload`, wire/AAD-дельта v1.1, процедура жюри, свойства безопасности) вынесена в [`franking.md`](./franking.md) (FSCP-FRANK v0.2); эталонная реализация примитивов — [`franking.ts`](../../Products/FSCP/ts/src/franking.ts) (`@flora/fscp`, реэкспорт `@flora/client-core/fscp`), поведение закреплено golden-вектором `fscp_franking_v1` с потребителями TS + Rust (§Test vectors). Gate FGP v2 «franking-RFC в FSCP принят хотя бы как draft» (FGP §8.3) — выполнен. Wire-дельта v1.1 **реализована в коде** (SoT `Products/FSCP/ts`, форк `Apps/Web/lib/fscp`): decrypt на обеих сторонах принимает v1 (без тега) и v1.1 (с тегом); эмиссия тега — явный параметр `emitFrankTag` у `buildFscpWireEnvelope` (проброшен через `buildBlocksMessageWire` / `buildTextMessageWire`), **выключен по умолчанию** — при выключении байты конверта и plaintext совпадают с v1. Боевое включение эмиссии — не автоматически: порядок выкладки и операционные проверки — [`franking.md`](./franking.md) §Активация. `MessageEnvelope.version` остаётся `1`, префикс `fscp1:`, `preKeyId` — `null`; это не pre-keys и не v2.

---

## Device revocation

После `POST .../devices/{id}/revoke`:

- новые envelope **не** содержат entry для отозванного устройства;
- сессии с отозванным устройством требуют re-handshake;
- негативный сценарий закреплён golden-транскриптом `message_session_revoked_device_v1_failure` ([fscp-revoked-device-v1.json](../test-vectors/fscp-revoked-device-v1.json)).

Криптографически wire отозванного устройства остаётся валидным (подпись и AEAD не знают о статусе) — отказ обязан приходить из **policy-слоя**, и вектор фиксирует обе стороны:

- **сервер**: send-путь извлекает `senderDeviceUuid` (`fscp_core::extract_sender_device_uuid`) и отклоняет wire устройства, у которого есть bindings в `user_device_keys`, но нет ни одного `Active` (403, golden-строка `fscp_core::REVOKED_SENDER_DEVICE_ERROR`); bootstrap sentinel v1 bindings не имеет и проходит без запроса к БД;
- **клиент (peer)**: перед обработкой входящего сопоставляет `senderDeviceUuid` со server-attested статусом (`evaluateInboundSenderDevice` в `@flora/fscp`): `Revoked` → конверт отклоняется, сессия → `compromised_local` (`device_revoked`);
- **клиент (отправитель)**: session FSM блокирует исходящие (`canSendOutbound === false`; `noteOutboundAccepted` бросает golden-строку); выход — только re-handshake.

---

## Test vectors

Каталог golden: **v1.0** (замороженный wire), аддитивная **v1.1 franking**, и **v2-draft** (вне нормы v1). Полный список файлов — [`Documents/test-vectors/README.md`](../test-vectors/README.md).

**v1.0** (и платформенные, привязанные к текущему wire):

| Vector id | Файл | Проверяет |
| --- | --- | --- |
| `fscp_rke_wrap_key_v1_success` | [fscp-rke-wrap-key-v1.json](../test-vectors/fscp-rke-wrap-key-v1.json) | X25519 + HKDF + AEAD → 32-байтовый `messageKey` |
| `fingerprint_v1_success` | [fingerprint-v1.json](../test-vectors/fingerprint-v1.json) | Safety number preimage + SHA-256 |
| `fscp_wire_validator_v1` | [fscp-wire-validator-v1.json](../test-vectors/fscp-wire-validator-v1.json) | Серверная структурная валидация wire: позитив + 26 негативов (27 кейсов), точные строки ошибок (форма заморожена, [`next-architecture.md`](../../next-architecture.md) §4.4 — Rust воспроизводит байт-в-байт) |
| `fscp_message_transcript_v1` | [fscp-message-transcript-v1.json](../test-vectors/fscp-message-transcript-v1.json) | **Полный транскрипт** Algorithm A/B: plaintext (unicode) → body AEAD → RKE обоих получателей → canonical JSON → Ed25519 → `fscp1:`-wire, со всеми промежуточными значениями; варианты `signature_tampered` (клиент и серверная криптопроверка отклоняют, форма проходит) и `legacy_unsigned` (v1.0-errata-5: клиент отклоняет по умолчанию, читает только через явный `allowUnsignedLegacy`; сервер отклоняет) |
| `fscp_franking_v1` | [franking-v1.json](../test-vectors/franking-v1.json) | Message franking ([`franking.md`](./franking.md)): commit → HMAC-тег → квитанция сервера → полная верификация жюри + негативы с причинами отказа; франкуется **сообщение транскрипт-вектора** (жалоба доказуема для реального wire) |
| `message_session_revoked_device_v1_failure` | [fscp-revoked-device-v1.json](../test-vectors/fscp-revoked-device-v1.json) | **Golden transcript revoke-сценария** (§Device revocation): M1 до revoke (decrypt ok, сессия ready) → revoke sender-устройства → M2 и повтор M1 отклоняются policy-слоем сервера (`REVOKED_SENDER_DEVICE_ERROR`) и клиента (`evaluateInboundSenderDevice` → `compromised_local`), исходящие блокирует session FSM; кейс `cryptoBypassDecrypt: ok` фиксирует, что криптография wire остаётся валидной — отказ политика, не крипто |
| `device_to_device_recovery_envelope_v1` | [fscp-d2d-recovery-v1.json](../test-vectors/fscp-d2d-recovery-v1.json) | `DeviceToDeviceRecoveryEnvelope` ([`e2e-security.md`](./e2e-security.md) §DeviceToDeviceRecoveryEnvelope): payload → X25519+HKDF+XChaCha20 → canonical JSON → Ed25519; server-side strict-валидация + подпись, client-side open; негативы: `_wrong_challenge`, `_tampered_ciphertext`, `_foreign_signature`, `_empty_epochs` |

**v1.1 franking** (`fscpProtocolVersion = 1.1`, `MessageEnvelope.version` = 1, `preKeyId` = `null`; эмиссия в бою off):

| Vector id | Файл | Проверяет |
| --- | --- | --- |
| `fscp_franking_wire_v1_1` | [fscp-franking-wire-v1_1.json](../test-vectors/fscp-franking-wire-v1_1.json) | Wire-дельта v1.1: детерминированный Algorithm A (commitInput, HMAC-тег, AAD `message.v1_1`) + recorded tagged `fscp1:` (roundtrip decrypt, подмена `frankTag` ломает AEAD) |
| `fscp_franking_disclosure_bundle_v2` | [fscp-franking-disclosure-bundle-v2.json](../test-vectors/fscp-franking-disclosure-bundle-v2.json) | Канонические байты кортежа раскрытия v1 + bundle v2 (N независимых кортежей, кап 20) и wrap в контексте `flora.fscp.franking-wrap.v2` со скоупом `bundleUuid` |

**v2-draft** (вне нормы v1):

| Vector id | Файл | Проверяет |
| --- | --- | --- |
| `fscp_hybrid_kem_v2draft_v1` | [fscp-hybrid-kem-v2draft-v1.json](../test-vectors/fscp-hybrid-kem-v2draft-v1.json) | Гибридный KEM X25519+ML-KEM-768 (§Целевой алгоритм → Post-quantum) — детерминированные keygen/encaps/decaps FIPS 203, transcript-hash, гибридный HKDF, AEAD; негативы: implicit rejection при подмене `ct_mlkem`, расхождение AAD-метаданных |

Регенерация: RKE — `python Documents/test-vectors/_gen_fscp_rke_v1.py`, транскрипт — `python Documents/test-vectors/_gen_fscp_message_transcript_v1.py`, franking — `python Documents/test-vectors/_gen_fscp_franking_v1.py` (после транскрипта; нужны `cryptography`, `PyNaCl`), гибридный KEM — `python Documents/test-vectors/_gen_fscp_hybrid_kem_v2draft_v1.py` (дополнительно нужен `kyber-py`), revoke-транскрипт — `python Documents/test-vectors/_gen_fscp_revoked_device_v1.py`, D2D recovery — `python Documents/test-vectors/_gen_fscp_d2d_recovery_v1.py`; `fscp-wire-validator-v1.json` — **заморожен** (исторически из C#-эталона, после Фазы 5 не регенерировать); franking wire v1.1 / disclosure bundle v2 — `npm run generate:franking-wire-v1-1-vector --workspace=@flora/fscp` и `npm run generate:franking-disclosure-bundle-v2-vector --workspace=@flora/fscp`. Файлы `Documents/test-vectors/**` — **regenerate-only**, руками не редактировать ([`AGENTS.md`](../../AGENTS.md)).

Правила новых векторов: `protocolVersion` / `fscpProtocolVersion` в JSON, base64url без padding, AAD **байт-в-байт** как в этом документе; негативы — отдельные файлы или блок `cases` с `expectedError`.

**Требование потребления (v1.0-errata-1, устраняет разрыв «вектор есть, но не проверяется»):** golden-векторы обязаны иметь **consumer-тесты**, иначе compliance-пункт считается невыполненным. Текущие потребители (CI: `npm run test` / `cargo test`):

- клиентский тест [`goldenVectors.test.ts`](../../Products/FSCP/ts/src/goldenVectors.test.ts): RKE unwrap даёт `messageKeyBase64Url` бит-в-бит (плюс покомпонентно: AAD-строка, X25519 shared secret, HKDF wrap key, детерминированный AEAD-шифротекст); `fingerprint-v1.json` — реализация safety number даёт `fingerprintSha256Hex`; `backend-parity/uuid-v1.json` — клиентские `deriveIds` сходятся с **замороженным** golden (исторический C#-эталон, Фаза 5 снята);
- **cross-impl parity:** [`webParity.test.ts`](../../Products/FSCP/ts/src/webParity.test.ts) утверждает, что `Apps/Web/lib/fscp/{constants,aad,canonicalJson,deriveIds}` дают **идентичный** результат с `@flora/fscp` (`Products/FSCP/ts`) на общих входах (защита от дрейфа двух клиентских реализаций до их консолидации, [`next-architecture.md`](../../next-architecture.md) §9);
- серверный тест (Rust) [`fscp_wire_vectors.rs`](../../Backend/Tests/parity/tests/fscp_wire_vectors.rs) прогоняет `fscp-wire-validator-v1.json` через `flora_messaging::fscp` (`fscp-core`): accept/reject и **точная строка ошибки**. Исторический C#-эталон `FscpWireEnvelopeValidator` снят вместе с хостом (Фаза 5); golden заморожен и больше не регенерируется из C#;
- клиентская криптография на RustCrypto: [`fscp_client_crypto_vectors.rs`](../../Backend/Tests/parity/tests/fscp_client_crypto_vectors.rs) воспроизводит RKE-вектор (X25519, HKDF, XChaCha20-Poly1305) и fingerprint-вектор — тройная верификация (python-генератор ↔ TS ↔ Rust) и задел Rust client-core;
- **полный транскрипт** `fscp_message_transcript_v1` потребляют TS [`transcriptVector.test.ts`](../../Products/FSCP/ts/src/transcriptVector.test.ts) (decrypt через `decryptFscpWireEnvelope`, canonical signing payload) и Rust [`fscp_transcript_vectors.rs`](../../Backend/Tests/parity/tests/fscp_transcript_vectors.rs) (RustCrypto + ed25519-dalek + порт canonical JSON [`canonical_json.rs`](../../Backend/Tests/parity/src/canonical_json.rs)). Это замыкает пару «клиентская криптография ⇄ серверная форма/подпись» на **одном** сообщении. Исторический C#-прогон того же wire снят с Фазой 5;
- **franking** `fscp_franking_v1`: TS [`frankingVector.test.ts`](../../Products/FSCP/ts/src/frankingVector.test.ts) — эталонная реализация `franking.ts` в `@flora/fscp` (commit, тег, квитанция, полный verify жюри); Rust [`fscp_franking_vectors.rs`](../../Backend/Tests/parity/tests/fscp_franking_vectors.rs) дополнительно доказывает, что Rust как серверный подписант детерминированно воспроизводит квитанцию из seed;
- **franking wire v1.1** `fscp_franking_wire_v1_1`: TS [`frankingWireVectorV1_1.test.ts`](../../Products/FSCP/ts/src/frankingWireVectorV1_1.test.ts) — Algorithm A байт-в-байт, roundtrip decrypt recorded tagged wire, AEAD-отказ при подмене `frankTag`; Rust [`fscp_franking_wire_v1_1.rs`](../../Backend/Tests/parity/tests/fscp_franking_wire_v1_1.rs) — тот же HMAC/AAD и ingest (`try_validate_wire` + `verify_envelope_signature` + `extract_frank_tag`); точечная проверка формы в `fscp-core` (`tagged_v1_1_golden_wire_passes_form_and_signature`);
- **franking disclosure/bundle v2** `fscp_franking_disclosure_bundle_v2`: TS [`frankingDisclosureBundleVector.test.ts`](../../Products/FSCP/ts/src/frankingDisclosureBundleVector.test.ts) — канонические байты кортежа и bundle, seal/wrap roundtrip; Rust в том же `fscp_franking_wire_v1_1.rs` воспроизводит HMAC кортежа и AAD wrap v2;
- **гибридный PQ-KEM (v2-draft)** `fscp_hybrid_kem_v2draft_v1`: TS [`hybridKemVector.test.ts`](../../Products/FSCP/ts/src/hybridKemVector.test.ts) (@noble/post-quantum, devDependency — продакшн-поверхности нет) и Rust [`fscp_hybrid_kem_vectors.rs`](../../Backend/Tests/parity/tests/fscp_hybrid_kem_vectors.rs) (RustCrypto `ml-kem`, dev-dependency) воспроизводят все шаги комбинера из §Post-quantum, включая FIPS 203 implicit rejection; вместе с генератором на kyber-py это **три независимые реализации ML-KEM-768**, согласные байт-в-байт;
- **revoke-транскрипт** `message_session_revoked_device_v1_failure`: TS `revokedDeviceVector.test.ts` (`@flora/fscp`) проигрывает всю цепочку через session FSM + `decryptFscpWireEnvelope` + `evaluateInboundSenderDevice` (включая честность вектора: crypto-bypass decrypt M2 успешен); Rust [`fscp_revoked_device_vectors.rs`](../../Backend/Tests/parity/tests/fscp_revoked_device_vectors.rs) — форма+подпись обоих wire, извлечение `senderDeviceUuid`, golden-строка policy-ошибки;
- **D2D recovery** `device_to_device_recovery_envelope_v1`: TS `d2dRecoveryVector.test.ts` (`@flora/fscp`) — деривация `targetAgreementPublicKeyId`, AAD и canonical signing payload байт-в-байт, open success + 4 негатива по категориям; Rust [`fscp_d2d_recovery_vectors.rs`](../../Backend/Tests/parity/tests/fscp_d2d_recovery_vectors.rs) — серверная strict-валидация + проверка подписи, точные строки ошибок.

Полный каталог платформенных векторов (backup, unlock, device): [`e2e-security.md`](./e2e-security.md) §Test vectors.

---

## Privacy boundaries

| Разрешено серверу | Запрещено |
| --- | --- |
| Хранить ciphertext, публичные ключи, метаданные доставки | Plaintext сообщений |
| Валидировать форму wire | Расшифровка истории |
| Rate limits, freeze policy | Fallback-ключ «для поддержки» |

E2E-переписка **не** используется для рекомендаций (FIRA). Подробнее: [`FIRA.md`](../fira/FIRA.md) §Privacy.

Метаданные (кто кому, когда, размеры) — частичный residual risk; см. [`SECURITY.md`](../../SECURITY.md).

**Governance-инварианты (FGP):** приватная переписка выведена из-под юрисдикции governance техническими инвариантами ([`../fgp/FGP.md`](../fgp/FGP.md) §1.1–§1.2): никакое решение FGP не может читать/выдавать содержимое E2E, вводить обязательное клиентское сканирование (§1.2 п. 7) или серверный escrow. Модерация E2E — только добровольная жалоба через franking (§Целевой алгоритм → Message franking; FGP §6.5). RFC, нарушающий эти пункты, — конституционный конфликт (FGP R3).

---

## Known MVP limitations (implementation)

Зафиксировано для текущего релиза; не ошибки спецификации, а отложенная реализация. Столбец «статус» отражает **фактическое** состояние кода на дату errata-6 (честный conformance):

| Ограничение | Статус | Деталь |
| --- | --- | --- |
| Сервер не верифицирует Ed25519 подпись envelope | ✅ закрыто (errata-5) | `fscp_core::verify_envelope_signature` — криптопроверка после замороженного валидатора формы (Algorithm C шаг 12); содержимое не расшифровывается |
| Клиентская подпись проверяется ключом из самого конверта | by design (v1) | целостность, не аутентичность против активного сервера |
| Длина ciphertext выдаёт длину сообщения | ✅ закрыто (errata-5) | паддинг plaintext до бакетов 256 Б / 1 КиБ (§MessageEnvelope) — утекает только номер бакета |
| Bootstrap key epoch + sentinel device UUID | by design (v1) | нет per-device ratchet; single epoch |
| E2E-ключи на вебе в `localStorage` | **известный риск** | `Apps/Web/lib/fscp/storage.ts` (Web-форк) и адаптер `keyStorage.ts` в `@flora/fscp`; target — non-extractable WebCrypto / IndexedDB |
| Legacy dual-ciphertext API | мост | `encryptedForReceiver`/`encryptedForSender` идентичны; путь к единому `fscp1:` |
| Safety number / fingerprint в UI | ✅ UI закрыт (errata-6) | `computeSafetyNumberV1` из `@flora/client-core/fscp` + «Проверка шифрования» в меню 1:1; peer identity берётся только из успешно расшифрованного и проверенного входящего wire, поэтому до первого входящего модал честно показывает not-ready. Локальный `verified contact` остаётся future work |
| `FscpV1ConversationSession` / session state | **реализовано (библиотека)** | чистая FSM [`conversationSession.ts`](../../Products/FSCP/ts/src/conversationSession.ts) в `@flora/fscp` (реэкспорт `@flora/client-core/fscp`; переходы + re-handshake, unit-тесты); интеграция в UI-поток — вместе с safety number surface |
| Golden-векторы в CI | ✅ подключены | consumer-тесты: `goldenVectors.test.ts` + `transcriptVector.test.ts` (`@flora/fscp`), `fscp_*_vectors.rs` (Rust, включая `fscp_wire_vectors.rs`); полный транскрипт покрывает байт-критичные пути — см. §Test vectors |
| Две параллельные клиентские реализации FSCP | **дрейф-риск, огорожен** | `Apps/Web/lib/fscp` vs `@flora/fscp` (`Products/FSCP/ts`); байт-критичные модули покрыты parity-тестом `webParity.test.ts`; консолидация форка на SoT `@flora/fscp` остаётся — [`next-architecture.md`](../../next-architecture.md) §2.0 / §9 |
| Golden transcript после device revoke | ✅ закрыто (errata-6) | `message_session_revoked_device_v1_failure` — [fscp-revoked-device-v1.json](../test-vectors/fscp-revoked-device-v1.json) + потребители TS/Rust; серверный device-policy на send-пути (`REVOKED_SENDER_DEVICE_ERROR`), клиентский inbound-policy `evaluateInboundSenderDevice`; HTTP `approve` (errata-5) и `recover-key` (errata-6) выставлены |
| Enforcement device-policy на send-пути ограничен | by design (v1) | v1-wire несёт bootstrap sentinel device (bindings нет — проверка не срабатывает); policy активируется автоматически с переходом на реальные per-device UUID в wire (v1.1+); отзыв материала при revoke уже действует через FSM/devices API |

---

## Versioning

| Версия | Содержание |
| --- | --- |
| **FSCP v1.0** | Текущая норма (этот документ); spec freeze 2026-05-10 |
| **FSCP v1.1 franking** | Wire-дельта `frankTag` / AAD `message.v1_1` ([`franking.md`](./franking.md)): код готов, эмиссия **off**; `MessageEnvelope.version` остаётся **1**, `preKeyId` = `null`. Боевая эмиссия — ступень 3 §Активация, не вместе с pre-keys |
| **FSCP v1.1 pre-keys** | `preKeyId != null` (roadmap, §Целевой алгоритм); в текущем wire не активировано |
| **FSCP v2** | X3DH + ratchet; гибридный PQ-KEM X25519+ML-KEM-768 (§Целевой алгоритм → Post-quantum) |

Изменения, **несовместимые с wire**, — только через bump major (`messageEnvelopeVersion`). Текстовые errata без смены байтов — в этом файле с пометкой `docs(fscp): errata` в commit message.

**Compliance checklist (v1.0)** — статус на errata-6:

1. ✅ Golden `fscp_rke_wrap_key_v1_success` и `fingerprint_v1_success` в CI — consumer-тесты `Products/FSCP/ts/src/goldenVectors.test.ts` (`npm run test`).
2. ✅ Server-side validation без отклонений от §Server-side validation (реализовано, включая проверку `recipientAgreementPublicKeyId`); поведение закреплено golden-вектором `fscp_wire_validator_v1` + consumer [`fscp_wire_vectors.rs`](../../Backend/Tests/parity/tests/fscp_wire_vectors.rs).
3. ✅ Клиент: AAD и HKDF-info **байт-в-байт** как в §MessageEnvelope / §Key agreement (подтверждено consumer-тестами RKE-вектора).
4. ✅ Cross-impl parity-тест `Apps/Web/lib/fscp` ↔ `@flora/fscp` — `webParity.test.ts` (constants, AAD, canonical JSON, deriveIds).
5. ✅ Полный транскрипт `fscp_message_transcript_v1`: каждая байт-критичная операция v1 (canonical JSON → подпись → RKE → тело) закреплена golden-вектором и потребляется TS + Rust (§Test vectors). Полное покрытие путей Algorithm A/B достигнуто.
6. ✅ Safety number в UI 1:1 после `ready` — пункт «Проверка шифрования» показывает 64-символьный fingerprint группами и поддерживает копирование; расчёт идёт через `computeSafetyNumberV1` (golden `fingerprint-v1.json`). В текущем bootstrap/TOFU-потоке `ready` подтверждается первым успешно расшифрованным входящим wire; до него UI не выдаёт непроверенный код.

---

## Open Questions / Future Work

- ✅ Серверная криптопроверка Ed25519 подписи envelope (defense-in-depth) — выполнено в errata-5 (`fscp_core::verify_envelope_signature`, Algorithm C шаг 12).
- ✅ Golden transcript `message_session_revoked_device_v1_failure` + HTTP `recover-key` (POST/GET, серверная валидация + хранилище с TTL) — выполнено в errata-6; `approve` выставлен ранее (errata-5, [`e2e-security.md`](./e2e-security.md) §Devices).
- Safety number: добавить локальный `verified contact` и сбрасывать его при смене epoch identity; сам OOB fingerprint UI 1:1 выполнен в errata-6.
- Консолидация Web-форка `Apps/Web/lib/fscp` на SoT `@flora/fscp` (`Products/FSCP/ts`; `@flora/client-core/fscp` остаётся реэкспортом, [`next-architecture.md`](../../next-architecture.md) §2.0 / §9); parity-тест уже защищает от дрейфа байт-критичных модулей.
- Переход с bootstrap epoch на реальные per-device UUID и key epochs.
- ✅ Message franking wire-дельта v1.1: реализована в `@flora/fscp` (SoT `Products/FSCP/ts`, форк `Apps/Web/lib/fscp`); серверный подписант квитанций — из конфигурации `Messaging:FrankingSigningSeed`. Эмиссия `frankTag` выключена по умолчанию (`emitFrankTag`); в бою не включена. Боевой rollout — [`franking.md`](./franking.md) §Активация (три ступени). Не закрыто продуктом: экран раскрытия Gov, multi-select в UI чата, приём bundle на Social, обязательный reject untagged-сообщений, ротация server key — см. тот же §.
- Post-quantum: ✅ прототип комбинера X25519+ML-KEM-768 закреплён вектором `fscp_hybrid_kem_v2draft_v1` (три реализации ML-KEM, потребители TS + Rust). До v2 design review остаются: перенос комбинера в pre-key bundle/PQXDH-поток и внешний криптоаудит гибридного KDF.
- Key transparency phase 2.
- Групповой чат (отдельная спецификация, возможно MLS).
- Хранение E2E material: WebCrypto `extractable: false`, IndexedDB.

---

*Платформа E2E (аккаунт, recovery, API): [`e2e-security.md`](./e2e-security.md). Test vectors: [`Documents/test-vectors/README.md`](../test-vectors/README.md).*

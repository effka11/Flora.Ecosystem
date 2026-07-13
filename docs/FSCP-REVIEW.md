# Ревью FSCP (Flora Secure Communication Protocol)

**Дата:** 2026-07-14  
**Объект:** [`docs/fscp/FSCP.md`](./fscp/FSCP.md) (v1.0 + errata-1…4), [`franking.md`](./fscp/franking.md), эталонная реализация `@flora/client-core/fscp`, серверный валидатор, golden-векторы  
**Контекст:** заморозка wire v1 ([`next-architecture.md`](../next-architecture.md) §1.2, §4.4), конституционные рамки FGP ([`fgp/FGP.md`](./fgp/FGP.md) §1.2 п. 7, §6.5)  
**Статус ревью:** зафиксировано; пункты remediation — ниже (§Рекомендуемый порядок)

---

## Вердикт

Протокол в **хорошей форме** для MVP v1 под заморозкой wire:

- AAD-дисциплина последовательна (тело + RKE);
- «треугольник» golden-векторов (python ↔ TS ↔ Rust ↔ C#) замыкает байт-критичные пути Algorithm A/B;
- ограничения v1 (нет FS между сообщениями, подпись не привязана к identity, bootstrap epoch) задокументированы честно;
- franking (RFC + эталон + вектор) и прототип гибридного PQ-KEM (v2-draft) вынесены без касания байтов v1.

Ревью нашло **два actionable-дефекта в клиентском коде** (оба исправимы без смены wire), один **архитектурный DoS-вектор в session FSM** и несколько **расхождений документации с фактом**.

---

## Объём проверки

| Артефакт | Что смотрели |
| --- | --- |
| [`FSCP.md`](./fscp/FSCP.md) | Goals, wire, Algorithms A/B/C, Signature authenticity, Session, Safety number, Canonical, Server validation, Forward secrecy, roadmap (v1.1/v2/PQ/franking), Test vectors, Known limitations, Compliance |
| [`franking.md`](./fscp/franking.md) | Commit, wire-дельта v1.1, receipt, jury verify, свойства, негативы |
| [`e2e-security.md`](./fscp/e2e-security.md) | Модерация vs FGP (контекст, без полного re-read в этом проходе) |
| Client-core | `envelope.ts`, `aad.ts`, `canonicalJson.ts`, `rke.ts`, `franking.ts`, `conversationSession.ts`, `safetyNumber.ts`, golden consumers |
| Web-дубликат | `Apps/Web/lib/fscp/envelope.ts` vs client-core (diff) |
| Сервер | `Products/Flora.Social/FscpWireEnvelopeValidator.cs` (форма подписи) |
| Векторы | RKE, fingerprint, wire-validator, message-transcript, franking, hybrid-kem-v2draft |

---

## Существенные находки

### 1. Клиент принимает неподписанные конверты — окно downgrade (высокая, byte-neutral)

**Факт.** Сервер v1 **всегда** требует `senderSigningPublicKeyBase64Url` и `senderSignatureBase64Url` по форме (шаг 11 валидатора). Легитимного неподписанного v1-сообщения в хранилище быть не должно.

**Дефект.** Клиент при отсутствии ключа молча пропускает проверку:

```ts
// Packages/flora-client-core/src/fscp/envelope.ts — verifyDetachedEnvelopeSignature
if (!pkB64 || pkB64.trim().length === 0) return;
```

Скомпрометированный сервер (или write-доступ к БД) может отдать историю со **стёртой** подписью — клиент расшифрует без предупреждения. В unsigned-режиме также пропадает защита состава `recipients` (подпись — единственное, что мешает подменить RKE-строку).

**Спека.** Путь помечен deprecated «после device-key binding» — слишком поздно: клиент может жёстко отклонять unsigned **уже сейчас** без смены wire.

**Remediation.** Отклонять unsigned на клиенте; в транскрипт-векторе для `legacy_unsigned` сменить ожидание с «клиент читает» на «клиент отклоняет».

---

### 2. Fallback на случайный ключ подписи в `buildFscpWireEnvelope` (средняя, только client-core)

**Дефект.** В client-core:

```ts
const signingPublicKey =
  sodium.crypto_sign_seed_keypair?.(signSeed).publicKey ??
  (params.senderSigningPrivateKey.byteLength >= 64
    ? params.senderSigningPrivateKey.subarray(32, 64)
    : sodium.crypto_sign_keypair().publicKey); // ← случайная пара
```

Последняя ветвь генерирует **случайную** пару: в конверт попадёт pk, не соответствующий подписи → получатель отклонит. Тихий fallback маскирует ошибку конфигурации.

**Дрейф Web ↔ core.** Web-версия использует прямой `crypto_sign_seed_keypair` без этого fallback. `webParity.test.ts` покрывает только `constants` / `aad` / `canonicalJson` / `deriveIds` и **не** ловит расхождение build/verify.

**Remediation.** Заменить fallback на `throw`; расширить parity-покрытие на путь подписи (или консолидировать Web на `@flora/client-core`).

---

### 3. `decrypt_failure` → `compromised_local` — DoS от собеседника (средняя, design)

**Факт.** Сервер валидирует только форму, не криптографию RKE. Собеседник может прислать конверт с валидной формой и мусорным RKE для жертвы → decrypt падает → FSM `markCompromisedLocal("decrypt_failure")` → **исходящие жертвы заморожены** до re-handshake.

**Remediation (спека, errata byte-neutral).** Классифицировать сбои (нет RKE-строки / AEAD tag / подпись); не переводить в `compromised_local` с первого сбоя либо требовать подтверждения пользователя.

---

### 4. Подпись покрывает canonical-форму, не байты wire (низкая)

Получатель пересобирает `canonicalJson` из распарсенного JSON: два разных wire (порядок ключей, `1e2` vs `100`) могут дать одну подпись. Для v1 безвредно (смысловые поля в AAD), но это classic canonicalization malleability.

**Remediation.** Явно проговорить в §Canonical encoding — особенно перед Rust client-core (парсер/дубликаты ключей/числа).

---

### 5. Неизвестные `block` kinds молча выбрасываются (низкая, forward-compat)

`normalizePlaintextPayload` делает `continue` на нераспознанных блоках: сообщение v1.1+ из одних новых блоков у старого клиента становится **пустым** без UI «контент недоступен». Противоречит духу «неизвестные поля в strict mode → ошибка».

**Remediation.** Placeholder `unknown` или явная ошибка / индикация в UI.

---

## Расхождения документации с фактом

| Место | Проблема |
| --- | --- |
| `FSCP.md` §Test vectors | «позитив + **22 негатива**» — в `fscp-wire-validator-v1.json` фактически **26** негативов (27 кейсов). Не хардкодить число или обновить. |
| `FSCP.md` §Message franking | Ссылка на FSCP-FRANK **v0.1**; [`franking.md`](./fscp/franking.md) уже **v0.2**. |
| Compliance checklist | Заголовок «статус на errata-1», хотя правился по errata-4. |
| Known limitations / хранение ключей | Ссылка на `Apps/Web/lib/fscp/storage.ts`; адаптер в client-core — `keyStorage.ts`. |

---

## Что проверено и в порядке

| Область | Оценка |
| --- | --- |
| AAD / UUID lowercase / ` \| ` | Соответствует спеке; golden RKE + transcript |
| Canonical JSON (code-unit sort) | Спека + TS + Rust `canonical_json.rs` |
| Сортировка `recipients` до подписи | Клиент; сервер проверяет состав, не порядок — by design |
| Server form validation | C# + Rust порт + wire-validator vector |
| Полный transcript Algorithm A/B | TS + Rust + C# consumers |
| Franking (Grubbs-style commit + blind receipt) | RFC + `franking.ts` + vector + негативы |
| Hybrid PQ combiner (v2-draft) | Три реализации ML-KEM-768; IKM `ss_x25519 ‖ ss_mlkem`; implicit rejection в негативе |
| Честные риски v1 | Signature authenticity, bootstrap epoch, localStorage, dual-wire, нет FS до ratchet — осознанно |

---

## Compliance v1 (снимок на дату ревью)

| # | Пункт | Статус |
| --- | --- | --- |
| 1 | Golden RKE + fingerprint в CI | ✅ |
| 2 | Server-side validation + wire-validator vector | ✅ |
| 3 | AAD/HKDF байт-в-байт | ✅ |
| 4 | Web ↔ client-core parity (байт-критичные модули) | ✅ (дыры: build/verify подписи — см. находку 2) |
| 5 | Полный message transcript | ✅ |
| 6 | Safety number UI 1:1 после `ready` | ⛔ (расчёт + FSM в библиотеке; UI нет) |

---

## Рекомендуемый порядок действий

1. **Отклонять unsigned-конверты** на клиенте (находка 1) + обновить ожидание `legacy_unsigned` в транскрипт-векторе — максимальный выигрыш в безопасности при byte-neutral правке.
2. **Убрать fallback случайного signing key** → `throw` (находка 2); расширить parity Web ↔ core на подпись.
3. **Errata-5 (byte-neutral):** классификация decrypt-сбоев для FSM (находка 3); при желании — п. 4–5 (canonical malleability, unknown blocks).
4. **Документационный пакет:** число негативов wire-validator, версия FRANK в `FSCP.md`, заголовок checklist, путь `keyStorage`.

Пункты 1–2 и 4 не меняют wire v1 и совместимы с freeze миграции на Rust.

---

## Связанные артефакты

- Норма: [`docs/fscp/FSCP.md`](./fscp/FSCP.md), [`docs/fscp/franking.md`](./fscp/franking.md), [`docs/fscp/e2e-security.md`](./fscp/e2e-security.md)
- Векторы: [`docs/test-vectors/README.md`](./test-vectors/README.md)
- Миграция / freeze: [`next-architecture.md`](../next-architecture.md) §1.2, §4.4
- FGP: [`docs/fgp/FGP.md`](./fgp/FGP.md) §1.2 п. 7, §6.5, §8.3
- Эталон: `Packages/flora-client-core/src/fscp/`
- Сервер: `Products/Flora.Social/FscpWireEnvelopeValidator.cs`, `Backend/crates/modules/flora-messaging/src/fscp.rs`

---

*Ревью проведено 2026-07-14. Документ — снимок находок; remediation не выполнен автоматически при фиксации.*

---
name: flora-fscp-e2e
description: Правки FSCP/E2E messaging Flora — wire envelope, key epochs, Flora.Messaging. Вызывай при изменениях чата, шифрования, backup/recovery, e2e-security API.
---

# Flora.Ecosystem — FSCP / E2E messaging

Применять при правках защищённого чата, криптографии сообщений, key epochs, backup/recovery.

## Документы (читай перед правками)

| Документ | Что там |
|----------|---------|
| [`docs/fscp/FSCP.md`](../../docs/fscp/FSCP.md) | Wire-format сообщений, envelope, AAD, версии |
| [`docs/fscp/e2e-security.md`](../../docs/fscp/e2e-security.md) | Key epochs, backup, FSM аккаунта, HTTP API, server validation |

**FSCP** — сообщения (ciphertext, delivery). **e2e-security** — платформа (epochs, devices, recovery). Не смешивать ответственность.

## Архитектура

```
Apps/Web, Apps/Mobile
  → Flora.API → Products/Flora.Social (composition)
      → Modules/Flora.Messaging (messages, E2E state)
```

- Бизнес-логика messaging — **только** `Flora.Messaging`
- Модули **не** читают чужие DbContext
- UI чат: `Apps/Web` + skill `/apps-web-messages-chat` для UX

## Чеклист перед PR

1. Ломающий wire change → bump `messageEnvelopeVersion` / FSCP version (см. FSCP.md)
2. Server **не расшифровывает** ciphertext — только validation metadata
3. `keyEpochId`, device keys, epochSetHash — согласованность с e2e-security
4. Новые HTTP routes — в Social composition, не в API напрямую
5. `dotnet build`, `npm run typecheck` в затронутых workspaces

## Типичные ошибки

| Ошибка | Правильно |
|--------|-----------|
| Plaintext на сервере для «удобства debug» | Ciphertext + client-side decrypt only |
| Правка envelope без test vectors | Добавить/обновить vectors в spec или tests |
| Cross-module DB join для messaging | Events/contracts через Flora.Messaging API |
| `.js` в Apps/Web | TypeScript only |

## Связанные skills

- `/apps-web-messages-chat` — UI чата, стикеры, голос
- `/diagnose` — регрессии доставки/расшифровки

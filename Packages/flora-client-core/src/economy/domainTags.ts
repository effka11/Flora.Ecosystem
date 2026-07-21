/**
 * Реестр доменных меток FEP (FEP.md §9.2) — зеркало `flora-economy-crypto::domain`.
 *
 * Каждый хеш/подпись валютного слоя берётся над сообщением с префиксом
 * `flora/economy/v1/<операция>`. Метки зафиксированы байт-в-байт golden-вектором
 * `fep-domain-tags-v1.json`; их изменение — класс R3 (ломает исторические артефакты).
 */

/** Версия протокола FEP (входит в genesis-запись журнала). */
export const FEP_PROTOCOL_VERSION = 1;

/** Общий префикс всех меток FEP. */
export const FEP_DOMAIN_PREFIX = "flora/economy/v1/";

/** Хеш записи журнала (entry_hash). */
export const FEP_LEDGER_LEAF = "flora/economy/v1/ledger/leaf";

/** Подпись head витнессом (Signed Tree Head). */
export const FEP_LEDGER_STH = "flora/economy/v1/ledger/sth";

/** Merkle-лист (RFC 6962 leaf, доменно-тегированный). */
export const FEP_MERKLE_LEAF = "flora/economy/v1/merkle/leaf";

/** Merkle-внутренний узел (RFC 6962 node). */
export const FEP_MERKLE_NODE = "flora/economy/v1/merkle/node";

/** Подпись перевода LIV. */
export const FEP_TRANSFER_AUTH = "flora/economy/v1/transfer/auth";

/** Подписи линии взаимного кредита (обе стороны). */
export const FEP_TRUSTLINE_AUTH = "flora/economy/v1/trustline/auth";

/** Подпись платежа по цепочке взаимного кредита. */
export const FEP_CREDIT_TRANSFER_AUTH = "flora/economy/v1/credit-transfer/auth";

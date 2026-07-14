//! Реестр доменных меток (domain separation), FGP-CRYPTO §1.1.
//!
//! Каждый хеш/подпись берётся над сообщением с префиксом `flora/economy/v1/<операция>`.
//! Метки фиксируются байт-в-байт (test vectors) — их изменение ломает проверяемость исторических
//! артефактов и является изменением класса R3.

/// Общий префикс всех меток FEP.
pub const PREFIX: &str = "flora/economy/v1/";

/// Хеш листа журнала (entry_hash), см. [`crate::ledger`].
pub const LEDGER_LEAF: &str = "flora/economy/v1/ledger/leaf";

/// Корень поддерева журнала (Signed Tree Head) для витнесс-косайнинга.
pub const LEDGER_STH: &str = "flora/economy/v1/ledger/sth";

/// Merkle-лист (RFC 6962 leaf prefix, доменно-тегированный).
pub const MERKLE_LEAF: &str = "flora/economy/v1/merkle/leaf";

/// Merkle-внутренний узел (RFC 6962 node prefix).
pub const MERKLE_NODE: &str = "flora/economy/v1/merkle/node";

/// Сообщение, которое подписывает аккаунт при переводе Pollen.
pub const TRANSFER_AUTH: &str = "flora/economy/v1/transfer/auth";

/// Сообщение авторизации открытия/изменения линии взаимного кредита.
pub const TRUSTLINE_AUTH: &str = "flora/economy/v1/trustline/auth";

/// Сообщение авторизации перевода по взаимному кредиту.
pub const CREDIT_TRANSFER_AUTH: &str = "flora/economy/v1/credit-transfer/auth";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_labels_share_prefix() {
        for label in [
            LEDGER_LEAF,
            LEDGER_STH,
            MERKLE_LEAF,
            MERKLE_NODE,
            TRANSFER_AUTH,
            TRUSTLINE_AUTH,
            CREDIT_TRANSFER_AUTH,
        ] {
            assert!(
                label.starts_with(PREFIX),
                "{label} must start with {PREFIX}"
            );
        }
    }

    #[test]
    fn labels_are_unique() {
        let labels = [
            LEDGER_LEAF,
            LEDGER_STH,
            MERKLE_LEAF,
            MERKLE_NODE,
            TRANSFER_AUTH,
            TRUSTLINE_AUTH,
            CREDIT_TRANSFER_AUTH,
        ];
        for (i, a) in labels.iter().enumerate() {
            for b in &labels[i + 1..] {
                assert_ne!(a, b, "коллизия доменной метки");
            }
        }
    }
}

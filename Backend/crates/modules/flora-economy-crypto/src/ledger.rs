//! Журнал FEP: append-only хеш-цепочка экономических событий (класс Certificate Transparency,
//! FGP §6.4 / FGP-CRYPTO §8).
//!
//! Каждая запись ссылается на хеш предыдущей; head подписывают независимые витнессы
//! (косайнинг — уровень модуля/инфраструктуры, ядро даёт канонические байты STH). Любой клиент
//! (wasm-сборка этого же crate в `@flora/client-core`) может воспроизвести состояние реплеем
//! журнала и сверить хеши — «не верь серверу, проверь сам».
//!
//! В журнале **нет** плутократического консенсуса: порядок задаёт оператор-секвенсор, а честность
//! секвенсора проверяема (реплей + витнессы + внешнее якорение). Компрометация секвенсора ⇒
//! расхождение реплея у первого же клиента ⇒ событие лестницы деградации FGP §7.3 — тот же
//! паттерн отказобезопасности, что у governance-журнала.

use serde::{Deserialize, Serialize};

use crate::amount::{AccountId, Grains, Timestamp};
use crate::canonical::CanonicalWriter;
use crate::domain;
use crate::hash::{Hash32, ZERO_HASH, tagged};
use crate::params::Parameters;
use crate::sig::{PublicKeyBytes, SignatureBytes};

/// Тело записи журнала — все экономические события FEP v1.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum EntryBody {
    /// Учреждение журнала: версия протокола + genesis-параметры. Создаёт **ноль** grain.
    Genesis {
        protocol_version: u16,
        params: Parameters,
    },
    /// Смена параметров решением governance (R2); `policy_ref` — ссылка на PolicyArtifact FGP.
    ParametersUpdated {
        params: Parameters,
        policy_ref: String,
    },
    /// Открытие экономического аккаунта (владелец — человек или commons-структура).
    AccountOpened {
        account: AccountId,
        /// Ed25519-ключ владения аккаунтом (авторизация переводов).
        #[serde(with = "crate::hexser")]
        owner_key: PublicKeyBytes,
    },
    /// Начисление UBI за диапазон эпох. Единственный источник эмиссии.
    UbiIssued {
        account: AccountId,
        from_epoch: u64,
        to_epoch: u64,
        amount: Grains,
    },
    /// Начисление демерреджа: списание с аккаунта в Commons-казну.
    DemurrageCharged {
        account: AccountId,
        periods: u64,
        amount: Grains,
    },
    /// Перевод Pollen. Подпись отправителя обязательна.
    Transfer {
        from: AccountId,
        to: AccountId,
        amount: Grains,
        /// Клиентский идемпотентный идентификатор (16 байт).
        #[serde(with = "crate::hexser")]
        nonce: [u8; 16],
        #[serde(with = "crate::hexser")]
        signature: SignatureBytes,
    },
    /// Открытие/изменение линии доверия (лимиты со стороны каждого участника).
    TrustlineSet {
        lo: AccountId,
        hi: AccountId,
        limit_lo_to_hi: Grains,
        limit_hi_to_lo: Grains,
        #[serde(with = "crate::hexser")]
        signature_lo: SignatureBytes,
        #[serde(with = "crate::hexser")]
        signature_hi: SignatureBytes,
    },
    /// Платёж по цепочке линий доверия (path[0] — плательщик, последний — получатель).
    CreditTransfer {
        path: Vec<AccountId>,
        amount: Grains,
        #[serde(with = "crate::hexser")]
        nonce: [u8; 16],
        #[serde(with = "crate::hexser")]
        signature: SignatureBytes,
    },
    /// Расход Commons-казны по ратифицированной категории бюджета (FGP §10.2):
    /// казна платит получателю; `policy_ref` — категория действующего бюджет-артефакта.
    CommonsSpend {
        to: AccountId,
        amount: Grains,
        policy_ref: String,
    },
}

impl EntryBody {
    /// Канонические байты тела (consensus-путь: вход хеша записи).
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut w = CanonicalWriter::new();
        match self {
            EntryBody::Genesis {
                protocol_version,
                params,
            } => {
                w.u8(0).u16(*protocol_version);
                write_params(&mut w, params);
            }
            EntryBody::ParametersUpdated { params, policy_ref } => {
                w.u8(1);
                write_params(&mut w, params);
                w.str(policy_ref);
            }
            EntryBody::AccountOpened { account, owner_key } => {
                w.u8(2).account(account).bytes(owner_key);
            }
            EntryBody::UbiIssued {
                account,
                from_epoch,
                to_epoch,
                amount,
            } => {
                w.u8(3)
                    .account(account)
                    .u64(*from_epoch)
                    .u64(*to_epoch)
                    .grains(*amount);
            }
            EntryBody::DemurrageCharged {
                account,
                periods,
                amount,
            } => {
                w.u8(4).account(account).u64(*periods).grains(*amount);
            }
            EntryBody::Transfer {
                from,
                to,
                amount,
                nonce,
                signature,
            } => {
                w.u8(5)
                    .account(from)
                    .account(to)
                    .grains(*amount)
                    .bytes(nonce)
                    .bytes(signature);
            }
            EntryBody::TrustlineSet {
                lo,
                hi,
                limit_lo_to_hi,
                limit_hi_to_lo,
                signature_lo,
                signature_hi,
            } => {
                w.u8(6)
                    .account(lo)
                    .account(hi)
                    .grains(*limit_lo_to_hi)
                    .grains(*limit_hi_to_lo)
                    .bytes(signature_lo)
                    .bytes(signature_hi);
            }
            EntryBody::CreditTransfer {
                path,
                amount,
                nonce,
                signature,
            } => {
                w.u8(7)
                    .account_list(path)
                    .grains(*amount)
                    .bytes(nonce)
                    .bytes(signature);
            }
            EntryBody::CommonsSpend {
                to,
                amount,
                policy_ref,
            } => {
                w.u8(8).account(to).grains(*amount).str(policy_ref);
            }
        }
        w.finish()
    }
}

fn write_params(w: &mut CanonicalWriter, p: &Parameters) {
    w.u32(p.demurrage_ppm_per_period)
        .i64(p.demurrage_period_ms)
        .grains(p.demurrage_exempt_threshold)
        .grains(p.ubi_per_epoch)
        .i64(p.ubi_epoch_ms)
        .u64(p.ubi_max_backfill_epochs)
        .grains(p.trustline_max_limit)
        .u8(p.credit_path_max_hops);
}

/// Запись журнала: порядковый номер, время, тело и хеш-ссылка на предыдущую.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    /// Порядковый номер (genesis = 0).
    pub seq: u64,
    /// Метка времени секвенсора (Unix-мс UTC); монотонна по журналу.
    pub at: Timestamp,
    /// Хеш предыдущей записи ([`ZERO_HASH`] для genesis).
    #[serde(with = "crate::hexser")]
    pub prev_hash: Hash32,
    /// Тело события.
    pub body: EntryBody,
}

impl LedgerEntry {
    /// Хеш записи: `H(leaf-label ‖ seq ‖ at ‖ prev_hash ‖ body_bytes)`.
    pub fn entry_hash(&self) -> Hash32 {
        let mut w = CanonicalWriter::new();
        w.u64(self.seq)
            .timestamp(self.at)
            .hash(&self.prev_hash)
            .bytes(&self.body.canonical_bytes());
        tagged(domain::LEDGER_LEAF, w.as_slice())
    }
}

/// Head журнала (аналог Signed Tree Head CT): всё, что подписывают витнессы.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerHead {
    /// Число записей в журнале.
    pub size: u64,
    /// Хеш последней записи (хеш-цепочка).
    #[serde(with = "crate::hexser")]
    pub last_entry_hash: Hash32,
    /// Merkle-корень всех entry_hash (для inclusion/consistency-доказательств).
    #[serde(with = "crate::hexser")]
    pub merkle_root: Hash32,
    /// Метка времени последней записи.
    pub at: Timestamp,
}

impl LedgerHead {
    /// Канонические байты head — вход подписи витнесса (`LEDGER_STH`).
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut w = CanonicalWriter::new();
        w.u64(self.size)
            .hash(&self.last_entry_hash)
            .hash(&self.merkle_root)
            .timestamp(self.at);
        w.finish()
    }

    /// Head пустого журнала (до genesis).
    pub fn empty() -> LedgerHead {
        LedgerHead {
            size: 0,
            last_entry_hash: ZERO_HASH,
            merkle_root: ZERO_HASH,
            at: Timestamp(0),
        }
    }
}

/// Канонические байты авторизации перевода (то, что подписывает отправитель).
pub fn transfer_signing_bytes(
    from: &AccountId,
    to: &AccountId,
    amount: Grains,
    nonce: &[u8; 16],
) -> Vec<u8> {
    let mut w = CanonicalWriter::new();
    w.account(from).account(to).grains(amount).bytes(nonce);
    w.finish()
}

/// Канонические байты авторизации линии доверия (подписывают обе стороны).
pub fn trustline_signing_bytes(
    lo: &AccountId,
    hi: &AccountId,
    limit_lo_to_hi: Grains,
    limit_hi_to_lo: Grains,
) -> Vec<u8> {
    let mut w = CanonicalWriter::new();
    w.account(lo)
        .account(hi)
        .grains(limit_lo_to_hi)
        .grains(limit_hi_to_lo);
    w.finish()
}

/// Канонические байты авторизации перевода по взаимному кредиту (подписывает плательщик).
pub fn credit_transfer_signing_bytes(
    path: &[AccountId],
    amount: Grains,
    nonce: &[u8; 16],
) -> Vec<u8> {
    let mut w = CanonicalWriter::new();
    w.account_list(path).grains(amount).bytes(nonce);
    w.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn acc(n: u8) -> AccountId {
        AccountId([n; 16])
    }

    #[test]
    fn entry_hash_is_deterministic_and_sensitive() {
        let entry = LedgerEntry {
            seq: 0,
            at: Timestamp(1_000),
            prev_hash: ZERO_HASH,
            body: EntryBody::Genesis {
                protocol_version: 1,
                params: Parameters::genesis(),
            },
        };
        assert_eq!(entry.entry_hash(), entry.entry_hash());

        let mut other = entry.clone();
        other.at = Timestamp(1_001);
        assert_ne!(entry.entry_hash(), other.entry_hash());
    }

    #[test]
    fn body_variants_have_distinct_canonical_bytes() {
        let a = EntryBody::UbiIssued {
            account: acc(1),
            from_epoch: 0,
            to_epoch: 0,
            amount: Grains(5),
        }
        .canonical_bytes();
        let b = EntryBody::DemurrageCharged {
            account: acc(1),
            periods: 0,
            amount: Grains(5),
        }
        .canonical_bytes();
        assert_ne!(a, b, "разные варианты обязаны иметь разные байты (u8-тег)");
    }

    #[test]
    fn signing_bytes_bind_all_fields() {
        let base = transfer_signing_bytes(&acc(1), &acc(2), Grains(10), &[0u8; 16]);
        assert_ne!(
            base,
            transfer_signing_bytes(&acc(1), &acc(2), Grains(11), &[0u8; 16])
        );
        assert_ne!(
            base,
            transfer_signing_bytes(&acc(1), &acc(3), Grains(10), &[0u8; 16])
        );
        assert_ne!(
            base,
            transfer_signing_bytes(&acc(1), &acc(2), Grains(10), &[1u8; 16])
        );
    }

    #[test]
    fn json_serialization_is_camel_case() {
        let entry = LedgerEntry {
            seq: 3,
            at: Timestamp(5),
            prev_hash: ZERO_HASH,
            body: EntryBody::CommonsSpend {
                to: acc(2),
                amount: Grains(7),
                policy_ref: "budget-2026/infrastructure".into(),
            },
        };
        let json = serde_json::to_string(&entry).unwrap();
        assert!(json.contains("\"prevHash\""));
        assert!(json.contains("\"policyRef\""));
        assert!(json.contains("\"kind\":\"commonsSpend\""));
    }
}

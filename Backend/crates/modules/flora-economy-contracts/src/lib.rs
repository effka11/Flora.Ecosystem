//! Контракты модуля Economy (FEP) — то, что видят другие модули и композиция.
//!
//! Правило §2.3: здесь только DTO, trait-порты и ошибки порта; бизнес-логики нет.
//! Внутренние типы движка (`flora-economy-crypto`) наружу не экспортируются: чужой модуль
//! знает про Pollen ровно столько, сколько описано в этих DTO. Суммы в контрактах — **grain**
//! (целые i64): десятичное представление — забота клиентов.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Ошибки порта Economy (транспортно-нейтральные).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EconomyPortError {
    #[error("экономический аккаунт не найден")]
    AccountNotFound,
    #[error("аккаунт уже открыт")]
    AccountAlreadyExists,
    #[error("операция отклонена движком: {0}")]
    Rejected(String),
    #[error("хранилище журнала недоступно: {0}")]
    StorageUnavailable(String),
}

/// Сводка экономического аккаунта.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EconomyAccountSummaryDto {
    pub account_uuid: Uuid,
    /// Баланс Pollen в grain (1 pollen = 10^6 grain).
    pub balance_grains: i64,
    /// Последняя UBI-эпоха, за которую начислено (None — ещё ни разу).
    pub last_ubi_epoch: Option<u64>,
    /// Метка последнего начисления демерреджа (Unix-мс UTC).
    pub demurrage_applied_at_ms: i64,
}

/// Сводка Commons-казны (демерредж-поступления минус расходы).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommonsSummaryDto {
    pub balance_grains: i64,
    /// Всего эмитировано UBI за историю (контрольная сумма сохранения).
    pub total_issued_grains: i64,
}

/// Head журнала — то, что подписывают витнессы и сверяют клиенты.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerHeadDto {
    pub size: u64,
    /// Hex (64 символа).
    pub last_entry_hash: String,
    /// Hex (64 символа).
    pub merkle_root: String,
    pub at_ms: i64,
}

/// Порт «открыть экономический аккаунт» — вызывается модулем Users/Auth при онбординге
/// (через композицию продукта; сами Users про Pollen не знают).
pub trait EconomyAccountProvisioner: Send + Sync {
    /// Идемпотентно открыть аккаунт с ключом владения Ed25519 (32 байта).
    fn open_account(
        &self,
        account_uuid: Uuid,
        owner_key: [u8; 32],
    ) -> Result<EconomyAccountSummaryDto, EconomyPortError>;
}

/// Порт чтения для governance-дашбордов и композиции (FGP §10: бюджет казны — публичный).
pub trait EconomyReadPort: Send + Sync {
    fn account_summary(
        &self,
        account_uuid: Uuid,
    ) -> Result<EconomyAccountSummaryDto, EconomyPortError>;
    fn commons_summary(&self) -> Result<CommonsSummaryDto, EconomyPortError>;
    fn ledger_head(&self) -> Result<LedgerHeadDto, EconomyPortError>;
}

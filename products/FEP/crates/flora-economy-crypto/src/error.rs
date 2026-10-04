//! Ошибки ядра FEP. Тексты — стабильная часть контракта модуля (машиночитаемые коды
//! добавляет HTTP-слой `flora-economy`; ядро остаётся транспортно-нейтральным).

use crate::amount::AccountId;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum EconomyError {
    #[error("аккаунт не найден: {0:?}")]
    AccountNotFound(AccountId),

    #[error("аккаунт уже существует: {0:?}")]
    AccountAlreadyExists(AccountId),

    #[error("недостаточно средств: баланс {balance} grain, требуется {required} grain")]
    InsufficientFunds { balance: i64, required: i64 },

    #[error("сумма должна быть положительной")]
    NonPositiveAmount,

    #[error("перевод самому себе не имеет смысла")]
    SelfTransfer,

    #[error("арифметическое переполнение — операция отклонена")]
    Overflow,

    #[error("линия доверия не найдена")]
    TrustlineNotFound,

    #[error(
        "превышена ёмкость линии доверия: доступно {available} grain, требуется {required} grain"
    )]
    TrustlineCapacityExceeded { available: i64, required: i64 },

    #[error("лимит линии доверия превышает максимальный, разрешённый параметрами")]
    TrustlineLimitTooHigh,

    #[error("путь взаимного кредита пуст или содержит повторяющиеся узлы")]
    InvalidCreditPath,

    #[error("метка времени операции раньше метки времени состояния (время не идёт вспять)")]
    NonMonotonicTime,

    #[error("некорректный публичный ключ")]
    InvalidPublicKey,

    #[error("подпись не прошла проверку")]
    InvalidSignature,

    #[error("реплей журнала разошёлся: ожидался хеш {expected}, получен {actual}")]
    ReplayDiverged { expected: String, actual: String },

    #[error("нарушен инвариант сохранения: {0}")]
    ConservationViolated(String),

    #[error("демерредж уже начислен за эту метку времени")]
    DemurrageAlreadyApplied,

    #[error("эмиссия UBI уже начислена аккаунту за эту эпоху")]
    UbiAlreadyClaimed,

    #[error("для начисления UBI требуется активная personhood-аттестация V1+")]
    PersonhoodRequired,
}

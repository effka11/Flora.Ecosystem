//! # flora-economy-crypto — детерминированное ядро Flora Economic Protocol (FEP)
//!
//! Нормативная спецификация — [`Documents/fep/FEP.md`](../../../../Documents/fep/FEP.md); криптослой рифмуется
//! с [`Documents/fgp/FGP-CRYPTO.md`](../../../../Documents/fgp/FGP-CRYPTO.md) (общие принципы: детерминизм,
//! transparent-примитивы, одно ядро native+wasm). Этот crate реализует **экономический движок**:
//! состояние, переходы, инварианты сохранения и проверяемый журнал.
//!
//! ## Что это и чем это НЕ является
//!
//! FEP — валюта **LIV** (Leaves; единица `liv`, атом `grain`), спроектированная как пост-дефицитная,
//! пост-капиталистическая: эмиссия по числу людей (PoP-UBI), а не по капиталу; демерредж вместо
//! процента; ликвидность из доверия (взаимный кредит), а не из искусственного дефицита.
//!
//! **Главный инвариант Flora (FGP аксиома A2): деньги не конвертируются во власть.** В этом crate
//! намеренно НЕТ ни одной функции, превращающей [`Grains`] в вес голоса, гражданские QV-кредиты,
//! репутацию или personhood. LIV покупает товары/услуги/общее — и только. Governance-домен
//! (FGP) задаёт параметры FEP решением класса R2, но не может купить за LIV ни грамма власти,
//! потому что покупать нечего.
//!
//! Здесь также нет Proof-of-Work и Proof-of-Stake: и то и другое — «капитал покупает консенсус/
//! влияние», что противоречит A2. Целостность обеспечивается прозрачным журналом
//! (хеш-цепочка + Merkle + независимые витнессы + клиентская верификация), а не гонкой капитала.
//!
//! ## Слои
//!
//! - [`fixed`] — знаковая фикс-пойнт арифметика Q32.32 (round-half-even, saturate), как FGP-CRYPTO §10.
//! - [`amount`] — [`Grains`]: целочисленные суммы, checked-операции.
//! - [`domain`] — реестр доменных меток (`flora/economy/v1/...`).
//! - [`hash`] — SHA-256 хелперы и хеш-цепочка.
//! - [`merkle`] — RFC 6962-совместимое дерево: корень, inclusion/consistency доказательства.
//! - [`canonical`] — детерминированная байтовая сериализация («спецификация — это байты»).
//! - [`sig`] — Ed25519 подпись/верификация над доменно-тегированным сообщением.
//! - [`demurrage`] — геометрический демерредж (Гезелль/Вёргль), целочисленно.
//! - [`issuance`] — начисление UBI (пост-дефицитная эмиссия по personhood).
//! - [`mutual_credit`] — линии доверия, ёмкость, путевой клиринг (нулевая сумма).
//! - [`ledger`] — записи журнала и их канонические байты/хеши.
//! - [`params`] — экономические параметры (устанавливает governance, R2).
//! - [`engine`] — чистый движок состояния: применение операций, инварианты, реплей-верификация.
//! - [`error`] — ошибки ядра.

pub mod amount;
pub mod canonical;
pub mod demurrage;
pub mod domain;
pub mod engine;
pub mod error;
pub mod fixed;
pub mod hash;
pub mod hexser;
pub mod issuance;
pub mod ledger;
pub mod merkle;
pub mod mutual_credit;
pub mod params;
pub mod sig;

pub use amount::{AccountId, Grains, LIV_IN_GRAINS, Timestamp};
pub use engine::{Account, LedgerState, Trustline};
pub use error::EconomyError;
pub use fixed::Fixed;
pub use ledger::{EntryBody, LedgerEntry, LedgerHead};
pub use params::Parameters;

/// Версия протокола FEP; входит в доменные метки и в genesis-запись журнала.
pub const FEP_PROTOCOL_VERSION: u16 = 1;

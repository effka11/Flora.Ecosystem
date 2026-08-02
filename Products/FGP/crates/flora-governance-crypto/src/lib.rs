//! # flora-governance-crypto — криптоядро FGP/FPP
//!
//! Единый детерминированный код для серверного тэлли и клиентской верификации
//! (native + wasm32): один и тот же крейт проверяет артефакты governance на сервере
//! и в `@flora/client-core` — дрейф паритета server↔client исключён по построению
//! (FGP §8.1; монокультурная оговорка — THREATS V-11).
//!
//! Нормативная спецификация — [`Documents/fgp/FGP-CRYPTO.md`]; поведение бит-в-бит
//! зафиксировано golden-векторами `Documents/test-vectors/governance/` (регенерация:
//! `cargo run -p flora-governance-crypto --example gen_vectors`).
//!
//! Состав (профиль P0 — FGP-CRYPTO §14):
//! - [`fx`] — арифметика Q32.32: round-half-even, насыщение, `exp2`/`log2`/`sqrt`
//!   без float (FGP-CRYPTO §10);
//! - [`ds`] — реестр доменных меток и BLAKE3-деривации (§1.1, §2);
//! - [`sig`] — Ed25519 над DS-таггированным сообщением (§1);
//! - [`merkle`] — Merkle-журнал прозрачности, inclusion/consistency (§8);
//! - [`sth`] — signed tree head, витнесс-косайны, клиентское правило «≥ 3» (§8);
//! - [`sortition`] — публичные жеребьёвки: сид окна, ранги, выборка (§6);
//! - [`commit_reveal`] — commit-reveal скрытых агрегатов (FGP §3.4);
//! - [`weights`] — формулы весов, затуханий, conviction, выборок и
//!   корреляционного дисконта FGP §4/§5.6;
//! - [`bridging`] — bridging-скоринг community notes L3 (FGP §6.2):
//!   детерминированная матричная факторизация на Q32.32.
//!
//! Профили P1 (VOPRF-токены, ECVRF, FROST) и P2 (DKG/ElGamal-тэлли, ZK) добавляются
//! по гейтам FGP-CRYPTO §14 — с внешним ревью и новыми векторами.
//!
//! Зависимостей на модули workspace нет: ядро компилируется в wasm32 и переносимо
//! в независимые верификаторы (community-target, THREATS V-11).

pub mod bridging;
pub mod commit_reveal;
pub mod ds;
pub mod fx;
pub mod merkle;
pub mod sig;
pub mod sortition;
pub mod sth;
pub mod weights;

/// Версия протокольных артефактов ядра (поле `protocolVersion` векторов).
pub const PROTOCOL_VERSION: u32 = 1;

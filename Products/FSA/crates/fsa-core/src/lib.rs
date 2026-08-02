//! FSA core — Flora Search Algorithm (functional product, headless/embeddable).
//! Spec: `Documents/fsa/FSA.md`.
//!
//! Ядро владеет всей механикой поиска: анализ текста (нормализация FSA-N1,
//! токенизация, раскладка ru↔en), инвертированный индекс, расширения запроса
//! (префикс, fuzzy d=1), BM25F, фразы/близость, свежесть, static-приор и
//! блендинг персонализации `S × (1 + α·λ_m·A(d))`. Поверхностные модули
//! FSA-F/A/M/P/C/N/D лишь направляют ядро профилем и типизируют API.
//!
//! Интеграция с FIRA — через данные ([`AffinitySnapshot`]), не через код:
//! FSA не зависит от crates FIRA и встраивается standalone. При `α = 0`
//! выдача бит-в-бит совпадает с неперсонализированной (инвариант §5.3).

pub mod document;
pub mod engine;
pub mod error;
mod executor;
mod fuzzy;
mod index;
pub mod personalization;
pub mod profile;
mod query;
pub mod text;

// Поверхностные модули (FSA-X).
pub mod audio;
pub mod communities;
pub mod drafts;
pub mod feed;
pub mod messages;
pub mod notifications;
pub mod people;

pub use document::Document;
pub use engine::{Hit, SearchEngine, SearchFilters, SearchRequest, SearchResponse};
pub use error::FsaError;
pub use personalization::PersonalizationContext;
pub use profile::{
    EngineLimits, ExpansionPolicy, FieldSpec, PersonalizationPolicy, RankingParams, RecencyMode,
    SearchProfile,
};

pub use fsa_contracts::{
    AffinityEntry, AffinitySnapshot, PersonalizationLevel, SearchDomain, SearchPreferences,
    affinity_key,
};

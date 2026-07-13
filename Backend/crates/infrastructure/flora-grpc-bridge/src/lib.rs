//! Переходный межъязыковой мост (next-architecture.md §5.2). Оживает в Фазе 2a:
//! tonic/prost поверх protos из `Infrastructure/Flora.gRPC/Protos/` (единый источник
//! для Rust и C#), транспорт — localhost, наружу не публикуется.
//!
//! Умирает по мере фаз 2b–4, когда порты снова становятся in-process.

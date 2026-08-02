/**
 * Personhood (FPP) — клиентская поверхность NS-слоя: зеркало portable-ядра
 * `fpp-core`/`fpp-crypto` (FPP-SIGNALS §2–§3, §7). Бит-в-бит паритет с Rust
 * зафиксирован векторами `Documents/test-vectors/personhood/`.
 *
 * Клиентский путь: локальные метрики (`temporal`) → квантование (`profile`)
 * → эпоха и девайс-тег (`epoch`, `deviceTag`) → отчёт эпохи (`report`).
 */

export * from "./registry.js";
export * from "./temporal.js";
export * from "./epoch.js";
export * from "./profile.js";
export * from "./deviceTag.js";
export * from "./report.js";

/**
 * Валютный слой LIV (FEP) на клиенте — `@flora/client-core/economy`.
 *
 * Чистый TS (`@noble`) — работает в Web и React Native; бит-в-бит паритет с ядром
 * `flora-economy-crypto` зафиксирован consumer-тестами golden-векторов
 * (`Documents/test-vectors/fep/`). Уровни проверки — LIV.md §5:
 * L0/L1 — этот модуль; L2 (полный реплей с инвариантами) — wasm-поверхность ядра
 * ([`FepWasmVerifier`]).
 */

export * from "./amounts.js";
export * from "./api.js";
export * from "./canonical.js";
export * from "./domainTags.js";
export * from "./encoding.js";
export * from "./hash.js";
export * from "./ledger.js";
export * from "./lightClient.js";
export * from "./merkle.js";
export * from "./sign.js";
export * from "./wallet.js";
export * from "./wasm.js";
export * from "./witness.js";

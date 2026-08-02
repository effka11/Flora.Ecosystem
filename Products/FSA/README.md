# PRODUCT_CLASS: functional
# FSA — Flora Search Algorithm (headless / embeddable)
#
# Spec: Documents/fsa/FSA.md (+ FSA-F/A/M/P/C/N/D)
# Scope: text analysis (FSA-N1 normalization, tokenization, ru↔en layout, fuzzy d=1),
#        inverted index, BM25F ranking, phrase/proximity, recency, static prior,
#        controlled personalization S × (1 + α·λ·A(d)) bridged from FIRA by DATA.
# Not in scope: persistence/sharding, HTTP, morphology/stemming, vector search (roadmap).
#
# Rust: crates/fsa-{contracts,core} (members of the root Cargo workspace)
#   fsa-contracts — PersonalizationLevel, AffinitySnapshot, SearchDomain, SearchPreferences (deps: serde)
#   fsa-core      — kernel + surface modules feed/audio/messages/people/communities/notifications/drafts (deps: fsa-contracts)
#
# Principles: quality without loss (executor == naive full scan), maximum speed via
#   exact index structures (no lossy score pruning), individuality controlled by α ∈ [0,1]
#   (0 = no FIRA integration, bit-identical for all users; 1 = maximum personalization).
# Portability: fsa-core is wasm32-friendly (client-side E2E messages search, FSA-M).

## Модули (FSA-X)

| Модуль | Поверхность | Особенность профиля |
|--------|-------------|---------------------|
| FSA-F | лента (посты) | самый персонализируемый (λ = 1.0), свежесть 48ч |
| FSA-A | музыка (треки) | агрессивный fuzzy, exact-boost названия/артиста, приор популярности |
| FSA-M | сообщения | клиентский индекс (wasm, E2E); аффинити только локально |
| FSA-P | люди | typeahead с 1 символа, сильнейший exact-boost username |
| FSA-C | сообщества | приор размера, тематическая персонализация (λ = 0.8) |
| FSA-N | уведомления | recency-first (`RecencyMode::Primary`) |
| FSA-D | черновики | неперсонализируем нормативно (λ = 0) |

## Команды

```sh
cargo test -p fsa-contracts -p fsa-core         # unit + инварианты
cargo clippy -p fsa-core --all-targets -- -D warnings
pwsh ./Tools/validate-architecture-rust.ps1     # границы зависимостей
```

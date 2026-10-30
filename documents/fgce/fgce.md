# FGCE Trellis — карточка продукта

- **Класс:** Functional (`PRODUCT_CLASS: functional`) — headless / embeddable ядро двумерной композиции. Своего Apps-shell нет.
- **Продукт:** [`products/fgce`](../../products/fgce) — собственный standalone workspace; в корневой workspace репозитория не входит.
- **Крейт:** [`products/fgce/crates/fgce`](../../products/fgce/crates/fgce) — переносимый, без зависимостей и `unsafe`; единственная дверь — `Engine::submit`.
- **Нормативная спека:** [`products/fgce/docs/fgce.md`](../../products/fgce/docs/fgce.md) — единственный источник закона композиции (sPx, сетка 5/15, дерево боксов, эталоны, растр, вектор, кадр).
- **Решения по спорным местам:** [`products/fgce/docs/questions.md`](../../products/fgce/docs/questions.md) — D1–D19, включая волны W0–W8 выпуска 0.2.0.
- **Wasm ABI:** [`products/fgce/docs/wasm-abi.md`](../../products/fgce/docs/wasm-abi.md); адаптер — `crates/fgce-wasm`.
- **Conformance:** [`products/fgce/tests/conformance`](../../products/fgce/tests/conformance) — карта §12, fuzz, benchmark, байтовые фикстуры.

Нормативных формул и таблиц эта карточка не содержит: они живут только в спеке продукта.

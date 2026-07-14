# Backend — Rust host crates (+ appsettings)

Workspace root is the **repository** [`Cargo.toml`](../Cargo.toml) (includes `Backend/crates/*` and `Products/*/crates/*`).
Run all cargo commands from the repo root:

```sh
cargo run -p flora-api
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pwsh ./tools/validate-architecture-rust.ps1
```

This directory holds the host binary crates (`flora-api`, `flora-shared`, `flora-migrate`, gRPC bridge) and config (`appsettings.json`).
App/functional products live under [`Products/`](../Products/). See [`next-architecture.md`](../next-architecture.md) §2 and [`ARCHITECTURE.md`](../ARCHITECTURE.md) §1.1.

Toolchain: repo-root [`rust-toolchain.toml`](../rust-toolchain.toml) (copy kept here for convenience).

# Backend — Rust host crates (+ appsettings)

Workspace root is the **repository** [`Cargo.toml`](../Cargo.toml) (includes `backend/crates/*` and `products/*/crates/*`).
Run all cargo commands from the repo root:

```sh
cargo run -p flora-api
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pwsh ./tools/validate-architecture-rust.ps1
```

This directory holds the host binary crates (`flora-api`, `flora-shared`, `flora-migrate`, gRPC bridge) and config (`appsettings.json`).

Local strangler parity (Web/Mobile → `:5290`):

```powershell
# from repo root
./scripts/run-dotnet-upstream-localhost.ps1   # :5284
./scripts/run-rust-gateway-localhost.ps1      # :5290, FLORA_CONFIG_DIR=backend
./scripts/web-dev-localhost.ps1               # proxy → :5290
```

Shared Jwt: `../local/.flora/dev-jwt.secret`. One-shot: `../scripts/zed-dev-api-web.ps1`.
App/functional products live under [`products/`](../products/). See [`next-architecture.md`](../next-architecture.md) §2 and [`architecture.md`](../architecture.md) §1.1.

Toolchain: repo-root [`rust-toolchain.toml`](../rust-toolchain.toml) (copy kept here for convenience).

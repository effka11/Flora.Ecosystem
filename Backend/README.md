# Backend — Rust host crates (+ appsettings)

Workspace root is the **repository** [`Cargo.toml`](../Cargo.toml) (includes `Backend/crates/*` and `Products/*/crates/*`).
Run all cargo commands from the repo root:

```sh
cargo run -p flora-api
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
pwsh ./Tools/validate-architecture-rust.ps1
```

This directory holds the host binary crates (`flora-api`, `flora-shared`, `flora-migrate`, gRPC bridge) and config (`appsettings.json`).

Local strangler parity (Web/Mobile → `:5290`):

```powershell
# from repo root
./Scripts/run-dotnet-upstream-localhost.ps1   # :5284
./Scripts/run-rust-gateway-localhost.ps1      # :5290, FLORA_CONFIG_DIR=Backend
./Scripts/web-dev-localhost.ps1               # proxy → :5290
```

Shared Jwt: `../Local/.flora/dev-jwt.secret`. One-shot: `../Scripts/zed-dev-api-web.ps1`.
App/functional products live under [`Products/`](../Products/). See [`next-architecture.md`](../next-architecture.md) §2 and [`ARCHITECTURE.md`](../ARCHITECTURE.md) §1.1.

Toolchain: repo-root [`rust-toolchain.toml`](../rust-toolchain.toml) (copy kept here for convenience).

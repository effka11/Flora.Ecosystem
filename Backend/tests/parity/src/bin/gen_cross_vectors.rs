//! Генератор кросс-языковых векторов «из Rust» (направление Rust → C#, §4.1):
//! детерминированный HS256-токен, который C#-тест (Flora.GoldenVectors) обязан валидировать.
//!
//! Эталон для этого файла — реализация `flora-auth`; регенерация:
//!   cargo run -p flora-parity --bin gen-cross-vectors
//! Файл руками не редактировать (правило docs/test-vectors).

use flora_auth::infrastructure::jwt::{AccessTokenClaims, JwtOptions, issue_access_token};

fn main() -> anyhow::Result<()> {
    // Те же константы, что в C#-векторе (GoldenVectorGenerator.cs) — единый паритетный набор.
    let options = JwtOptions {
        issuer: "Flora.Auth".into(),
        audience: "Flora.Ecosystem".into(),
        secret: "flora-backend-parity-jwt-secret-v1-0123456789".into(),
        access_token_minutes: 15,
        refresh_token_days: 7,
    };
    let claims = AccessTokenClaims {
        sub: "7f2c9a4e-1b3d-4c5e-8f6a-2d1e0b9c8a7f".into(),
        email: "parity@flora.local".into(),
        jti: "0123456789abcdef0123456789abcdef".into(),
        // 2126-01-01T00:00:00Z — как exp в C#-векторе.
        expires_at: 4_922_899_200,
    };
    let token = issue_access_token(&options, &claims);

    let vector = serde_json::json!({
        "vectorId": "backend_parity_jwt_hs256_rust_v1",
        "generatedBy": "Backend/tests/parity (cargo run -p flora-parity --bin gen-cross-vectors)",
        "algorithm": "HS256",
        "secretUtf8": options.secret,
        "issuer": options.issuer,
        "audience": options.audience,
        "token": token,
        "expectedSub": claims.sub,
        "expectedEmail": claims.email,
        "expectedJti": claims.jti,
        "expiresAtUnix": claims.expires_at,
    });

    let path = flora_parity::golden_vectors_dir().join("jwt-hs256-rust-v1.json");
    std::fs::write(
        &path,
        format!("{}\n", serde_json::to_string_pretty(&vector)?),
    )?;
    println!("записан {}", path.display());
    Ok(())
}

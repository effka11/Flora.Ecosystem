//! Кросс-языковой JWT-паритет (§4.1): токен, выпущенный C#, валиден в Rust,
//! и Rust-реализация воспроизводит wire-набор клеймов C# байт-в-байт.

use flora_auth::infrastructure::jwt::{
    AccessTokenClaims, JwtOptions, issue_access_token, validate_access_token,
};
use flora_parity::{golden_vectors_dir, load_json};

fn vector() -> serde_json::Value {
    load_json(&golden_vectors_dir().join("jwt-hs256-v1.json"))
        .expect("нет jwt-hs256-v1.json — сгенерируйте из C#: ./Scripts/generate-golden-vectors.ps1")
}

fn options_from_vector(v: &serde_json::Value) -> JwtOptions {
    JwtOptions {
        issuer: v["issuer"].as_str().unwrap().to_string(),
        audience: v["audience"].as_str().unwrap().to_string(),
        secret: v["secretUtf8"].as_str().unwrap().to_string(),
        access_token_minutes: 15,
        refresh_token_days: 7,
    }
}

/// Условное «сейчас» для валидации: вектор живёт до 2126 года.
const NOW_UNIX: i64 = 1_800_000_000;

#[test]
fn csharp_issued_token_validates_in_rust() {
    let vector = vector();
    let options = options_from_vector(&vector);
    let token = vector["token"].as_str().unwrap();

    let claims = validate_access_token(&options, token, NOW_UNIX)
        .expect("C#-токен обязан проходить Rust-валидацию");
    assert_eq!(claims.sub, vector["payload"]["sub"].as_str().unwrap());
    assert_eq!(claims.email, vector["payload"]["email"].as_str().unwrap());
    assert_eq!(claims.jti, vector["payload"]["jti"].as_str().unwrap());
    assert_eq!(
        claims.expires_at,
        vector["payload"]["exp"].as_i64().unwrap()
    );
}

#[test]
fn rust_issued_token_reproduces_csharp_wire_payload_exactly() {
    let vector = vector();
    let options = options_from_vector(&vector);
    let claims = AccessTokenClaims {
        sub: vector["payload"]["sub"].as_str().unwrap().to_string(),
        email: vector["payload"]["email"].as_str().unwrap().to_string(),
        jti: vector["payload"]["jti"].as_str().unwrap().to_string(),
        expires_at: vector["payload"]["exp"].as_i64().unwrap(),
    };

    let token = issue_access_token(&options, &claims);

    // Сравниваем декодированные header/payload с фактическими wire-байтами C#-токена.
    let decode = |part: &str| -> serde_json::Value {
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(part)
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    };
    let rust_parts: Vec<&str> = token.split('.').collect();
    let csharp_parts: Vec<&str> = vector["token"].as_str().unwrap().split('.').collect();

    assert_eq!(
        decode(rust_parts[0]),
        decode(csharp_parts[0]),
        "JOSE header"
    );
    assert_eq!(
        decode(rust_parts[1]),
        decode(csharp_parts[1]),
        "wire-набор клеймов"
    );
    // При идентичных header/payload и секрете подпись обязана совпасть байт-в-байт.
    assert_eq!(rust_parts[2], csharp_parts[2], "подпись HS256");
}

#[test]
fn committed_cross_vector_is_reproducible_from_rust_implementation() {
    // Файл генерируется gen-cross-vectors и валидируется C#-тестом; здесь — защита от дрейфа:
    // текущая Rust-реализация обязана выдавать ровно тот же токен.
    let path = golden_vectors_dir().join("jwt-hs256-rust-v1.json");
    let vector = load_json(&path).expect(
        "нет jwt-hs256-rust-v1.json — сгенерируйте: cargo run -p flora-parity --bin gen-cross-vectors",
    );
    let options = JwtOptions {
        issuer: vector["issuer"].as_str().unwrap().to_string(),
        audience: vector["audience"].as_str().unwrap().to_string(),
        secret: vector["secretUtf8"].as_str().unwrap().to_string(),
        access_token_minutes: 15,
        refresh_token_days: 7,
    };
    let claims = AccessTokenClaims {
        sub: vector["expectedSub"].as_str().unwrap().to_string(),
        email: vector["expectedEmail"].as_str().unwrap().to_string(),
        jti: vector["expectedJti"].as_str().unwrap().to_string(),
        expires_at: vector["expiresAtUnix"].as_i64().unwrap(),
    };
    assert_eq!(
        issue_access_token(&options, &claims),
        vector["token"].as_str().unwrap(),
        "Rust-токен разошёлся с закоммиченным вектором — перегенерируйте gen-cross-vectors",
    );
}

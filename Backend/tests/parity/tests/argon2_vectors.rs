//! Паритет Argon2id с C# (Argon2PasswordHasher.cs): формат Base64(salt16‖hash32),
//! t=4, m=65536 KiB, p=2. Верификация хешей, созданных C#, — обязательное условие
//! бесшовной миграции Auth (пароли пользователей не перехешируются).
//!
//! Плюс грубый замер длительности verify — база для решения о blocking-пуле (§10).

use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine as _;
use flora_parity::{golden_vectors_dir, load_json};

const SALT_LEN: usize = 16;
const HASH_LEN: usize = 32;

fn verify_like_csharp(password: &str, stored_hash: &str) -> bool {
    let Ok(combined) = base64::engine::general_purpose::STANDARD.decode(stored_hash) else {
        return false;
    };
    if combined.len() != SALT_LEN + HASH_LEN {
        return false;
    }
    let (salt, expected) = combined.split_at(SALT_LEN);

    let params = Params::new(65536, 4, 2, Some(HASH_LEN)).expect("параметры эталона");
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut computed = [0u8; HASH_LEN];
    if argon2.hash_password_into(password.as_bytes(), salt, &mut computed).is_err() {
        return false;
    }
    // Тестовый контекст — сравнение не обязано быть constant-time (в проде — subtle).
    computed.as_slice() == expected
}

#[test]
fn csharp_created_hashes_verify_in_rust() {
    let vector = load_json(&golden_vectors_dir().join("argon2id-v1.json")).expect(
        "нет argon2id-v1.json — сгенерируйте из C#: ./Scripts/generate-golden-vectors.ps1",
    );

    for case in vector["cases"].as_array().unwrap() {
        let password = case["password"].as_str().unwrap();
        let stored_hash = case["storedHash"].as_str().unwrap();

        let started = std::time::Instant::now();
        assert!(verify_like_csharp(password, stored_hash), "пароль {password:?} отвергнут");
        println!("argon2id verify ({password:?}): {:?}", started.elapsed());

        assert!(!verify_like_csharp(&format!("{password}-wrong"), stored_hash));
    }
}

#[test]
fn malformed_stored_hash_is_rejected_not_panicking() {
    assert!(!verify_like_csharp("x", "не-base64"));
    assert!(!verify_like_csharp("x", &base64::engine::general_purpose::STANDARD.encode([0u8; 10])));
}

//! Загрузка конфигурации хоста и dev-поведение секретов — порт `Flora.API/Program.cs`.

use std::path::PathBuf;

use flora_shared::config::{FloraConfig, environment_name};

/// Плейсхолдеры, при которых секрет считается «не заданным» —
/// порт `FloraJwtExtensions.IsWeakOrPlaceholderSecret`.
const FORBIDDEN_SECRET_FRAGMENTS: [&str; 9] = [
    "DevelopmentSecretKey",
    "ChangeInProduction",
    "__JWT_SECRET",
    "changeme",
    "change-me",
    "change_me",
    "your-secret",
    "placeholder",
    "example",
];

pub fn is_weak_or_placeholder_secret(secret: &str) -> bool {
    let lowered = secret.to_lowercase();
    FORBIDDEN_SECRET_FRAGMENTS
        .iter()
        .any(|fragment| lowered.contains(&fragment.to_lowercase()))
}

/// Порт `FloraJwtExtensions.ShouldMintEphemeralDevelopmentSecret`.
pub fn should_mint_ephemeral_development_secret(secret: Option<&str>) -> bool {
    match secret {
        None => true,
        Some(s) if s.trim().len() < 32 => true,
        Some(s) => {
            is_weak_or_placeholder_secret(s)
                || s.trim()
                    .chars()
                    .collect::<std::collections::HashSet<_>>()
                    .len()
                    < 8
        }
    }
}

/// Каталог конфигов: `FLORA_CONFIG_DIR` → каталог бинаря → текущий каталог.
pub fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("FLORA_CONFIG_DIR") {
        let p = PathBuf::from(dir);
        if p.exists() {
            return p;
        }
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
        && dir.join("appsettings.json").exists()
    {
        return dir.to_path_buf();
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

/// Загрузка конфига хоста. В Development при отсутствующем/слабом `Jwt:Secret`
/// чеканится эфемерный секрет (48 случайных байт → base64) — как `Program.cs`;
/// свежий клон запускается из коробки, токены сбрасываются при рестарте.
pub fn load_host_config() -> anyhow::Result<FloraConfig> {
    let environment = environment_name();
    let dir = config_dir();
    let mut cfg = FloraConfig::load(&environment, &dir)
        .map_err(|e| anyhow::anyhow!("конфигурация ({}): {e}", dir.display()))?;

    if cfg.is_development() && should_mint_ephemeral_development_secret(cfg.get("Jwt:Secret")) {
        cfg = with_ephemeral_jwt_secret(cfg);
        tracing::info!("Development: выпущен эфемерный Jwt:Secret (сбрасывается при рестарте)");
    }
    validate_security_config(&cfg)?;
    Ok(cfg)
}

/// Инварианты, с которыми Production разрешено запускать.
///
/// Проверка живёт на границе host/config: продукт и модули получают уже безопасную
/// конфигурацию и не должны каждый по-своему угадывать, допустим ли секрет.
fn validate_security_config(cfg: &FloraConfig) -> anyhow::Result<()> {
    if !cfg.is_development() && should_mint_ephemeral_development_secret(cfg.get("Jwt:Secret")) {
        anyhow::bail!(
            "небезопасная Production-конфигурация: Jwt:Secret должен содержать \
             не менее 32 символов и не быть плейсхолдером"
        );
    }

    if !cfg.is_development() {
        let access_minutes = cfg.get_i64("Jwt:AccessTokenMinutes").unwrap_or(15);
        if !(1..=60).contains(&access_minutes) {
            anyhow::bail!(
                "небезопасная Production-конфигурация: Jwt:AccessTokenMinutes должен быть 1..=60"
            );
        }
        let refresh_days = cfg.get_i64("Jwt:RefreshTokenDays").unwrap_or(7);
        if !(1..=30).contains(&refresh_days) {
            anyhow::bail!(
                "небезопасная Production-конфигурация: Jwt:RefreshTokenDays должен быть 1..=30"
            );
        }
        if let Some(pepper) = cfg.get_non_empty("Verification:CodePepper")
            && should_mint_ephemeral_development_secret(Some(pepper))
        {
            anyhow::bail!(
                "небезопасная Production-конфигурация: Verification:CodePepper должен быть сильным секретом либо отсутствовать для fallback на Jwt:Secret"
            );
        }
    }

    if !cfg.is_development() && cfg.get_bool("Verification:ServeNative") == Some(true) {
        let raw = cfg
            .get_non_empty("Verification:GrpcListen")
            .unwrap_or("127.0.0.1:50051");
        let addr: std::net::SocketAddr = raw.parse().map_err(|e| {
            anyhow::anyhow!("Verification:GrpcListen '{raw}' не является адресом host:port: {e}")
        })?;
        if !addr.ip().is_loopback() {
            anyhow::bail!(
                "небезопасная Production-конфигурация: неаутентифицированный Verification gRPC \
                 разрешено слушать только на loopback, получено {addr}"
            );
        }
    }

    Ok(())
}

fn with_ephemeral_jwt_secret(mut cfg: FloraConfig) -> FloraConfig {
    use base64::Engine as _;
    // 48 случайных байт из CSPRNG ОС → base64, как RandomNumberGenerator.GetBytes(48) в C#.
    let mut secret_bytes = [0u8; 48];
    getrandom::fill(&mut secret_bytes).expect("CSPRNG ОС недоступен");
    let secret = base64::engine::general_purpose::STANDARD.encode(secret_bytes);
    cfg.set_override("Jwt:Secret", secret);
    cfg
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn production(secret: Option<&str>, grpc_listen: Option<&str>) -> FloraConfig {
        let mut root = json!({
            "Jwt": { "Secret": secret.unwrap_or_default() },
            "Verification": { "ServeNative": grpc_listen.is_some() }
        });
        if let Some(listen) = grpc_listen {
            root["Verification"]["GrpcListen"] = json!(listen);
        }
        FloraConfig::from_layers("Production", &[root], &[])
    }

    #[test]
    fn placeholder_secrets_are_rejected() {
        for bad in [
            "DevelopmentSecretKey-0123456789-0123456789",
            "please-change-me-please-change-me-please",
            "some-EXAMPLE-secret-some-example-secret!",
        ] {
            assert!(should_mint_ephemeral_development_secret(Some(bad)), "{bad}");
        }
    }

    #[test]
    fn short_or_missing_secret_mints_ephemeral() {
        assert!(should_mint_ephemeral_development_secret(None));
        assert!(should_mint_ephemeral_development_secret(Some("")));
        assert!(should_mint_ephemeral_development_secret(Some("short")));
    }

    #[test]
    fn strong_secret_is_kept() {
        assert!(!should_mint_ephemeral_development_secret(Some(
            "fd9f2cfa81c2f89ae1a106e28e89da6f1496db8f1cbaf2e5"
        )));
    }

    #[test]
    fn production_rejects_missing_short_and_placeholder_secrets() {
        for secret in [
            None,
            Some("short"),
            Some("__JWT_SECRET_MIN_32_CHARS__"),
            Some("please-change-me-before-production-123456"),
            Some("CHANGE_ME_TO_AT_LEAST_32_RANDOM_CHARACTERS"),
            Some("abcdabcdabcdabcdabcdabcdabcdabcd"),
        ] {
            let err = validate_security_config(&production(secret, None)).unwrap_err();
            assert!(err.to_string().contains("Jwt:Secret"), "{err}");
        }
    }

    #[test]
    fn production_accepts_strong_secret_and_loopback_verification() {
        let cfg = production(
            Some("fd9f2cfa81c2f89ae1a106e28e89da6f1496db8f1cbaf2e5"),
            Some("127.0.0.1:50051"),
        );
        validate_security_config(&cfg).unwrap();
    }

    #[test]
    fn production_rejects_network_exposed_verification_grpc() {
        let cfg = production(
            Some("fd9f2cfa81c2f89ae1a106e28e89da6f1496db8f1cbaf2e5"),
            Some("0.0.0.0:50051"),
        );
        let err = validate_security_config(&cfg).unwrap_err();
        assert!(err.to_string().contains("loopback"), "{err}");
    }

    #[test]
    fn production_rejects_excessive_token_lifetimes_and_weak_optional_pepper() {
        let strong = "fd9f2cfa81c2f89ae1a106e28e89da6f1496db8f1cbaf2e5";
        for root in [
            json!({
                "Jwt": { "Secret": strong, "AccessTokenMinutes": 1440 }
            }),
            json!({
                "Jwt": { "Secret": strong, "RefreshTokenDays": 365 }
            }),
            json!({
                "Jwt": { "Secret": strong },
                "Verification": { "CodePepper": "change-me-change-me-change-me-change-me" }
            }),
        ] {
            let cfg = FloraConfig::from_layers("Production", &[root], &[]);
            assert!(validate_security_config(&cfg).is_err());
        }
    }
}

//! Загрузка конфигурации хоста и dev-поведение секретов — порт `Flora.API/Program.cs`.

use std::path::PathBuf;

use flora_shared::config::{FloraConfig, environment_name};

/// Плейсхолдеры, при которых секрет считается «не заданным» —
/// порт `FloraJwtExtensions.IsWeakOrPlaceholderSecret`.
const FORBIDDEN_SECRET_FRAGMENTS: [&str; 8] = [
    "DevelopmentSecretKey",
    "ChangeInProduction",
    "__JWT_SECRET",
    "changeme",
    "change-me",
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
        Some(s) if s.trim().is_empty() || s.len() < 32 => true,
        Some(s) => is_weak_or_placeholder_secret(s),
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
    Ok(cfg)
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
}

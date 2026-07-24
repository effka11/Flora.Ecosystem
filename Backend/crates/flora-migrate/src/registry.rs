//! Реестр миграций по модулям.
//!
//! Решение §11.1 (next-architecture.md): инструмент — **sqlx migrate**, история — в отдельной
//! таблице на модуль `__flora_migrations_<module>` в схеме `flora_core` (продолжение паттерна
//! `__EFMigrationsHistory_<Module>`; EF-таблицы остаются как исторические, их никто не трогает).
//!
//! После завершённого cutover (Фаза 5) владельцы всех модулей — Rust. `migrator: None`
//! означает только отсутствие новых post-cutover миграций у модуля. Модуль с первой
//! эволюцией схемы объявляет `migrations/`-каталог у себя и экспортирует
//! `sqlx::migrate!()`-Migrator, который регистрируется здесь.
//!
//! Сейчас зарегистрированы: users/content/music (§User Controls FIRA v1.1) и messaging
//! (D2D recovery transport, e2e-security.md §Devices recover-key).

use sqlx::migrate::Migrator;

pub struct ModuleMigrations {
    /// Имя модуля в нижнем регистре (music, users, …).
    pub module: &'static str,
    /// Владелец по таблице статуса §6.0 — для сообщений dry-run.
    pub current_owner: &'static str,
    /// Мигратор модуля; None — post-cutover Rust-миграций пока нет.
    pub migrator: Option<&'static Migrator>,
}

impl ModuleMigrations {
    pub fn history_table(&self) -> String {
        format!("__flora_migrations_{}", self.module)
    }
}

/// Порядок применения повторяет порядок композиции продукта (§2.4).
pub fn registry() -> Vec<ModuleMigrations> {
    vec![
        ModuleMigrations {
            module: "users",
            current_owner: "Rust",
            migrator: Some(&flora_users::MIGRATOR),
        },
        ModuleMigrations {
            module: "verification",
            current_owner: "Rust",
            migrator: None,
        },
        ModuleMigrations {
            module: "auth",
            current_owner: "Rust",
            migrator: Some(&flora_auth::MIGRATOR),
        },
        ModuleMigrations {
            module: "notifications",
            current_owner: "Rust",
            migrator: Some(&flora_notifications::MIGRATOR),
        },
        ModuleMigrations {
            module: "content",
            current_owner: "Rust",
            migrator: Some(&flora_content::MIGRATOR),
        },
        ModuleMigrations {
            module: "messaging",
            current_owner: "Rust",
            migrator: Some(&flora_messaging::MIGRATOR),
        },
        ModuleMigrations {
            module: "music",
            current_owner: "Rust",
            migrator: Some(&flora_music::MIGRATOR),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_tables_are_per_module_and_snake_case() {
        let names: Vec<String> = registry()
            .iter()
            .map(ModuleMigrations::history_table)
            .collect();
        assert_eq!(names.len(), 7);
        assert!(names.contains(&"__flora_migrations_music".to_string()));
        let unique: std::collections::HashSet<&String> = names.iter().collect();
        assert_eq!(
            unique.len(),
            names.len(),
            "таблицы истории не должны совпадать"
        );
    }

    #[test]
    fn rust_owned_modules_with_registered_migrators() {
        // Фаза 5: все владельцы Rust; migrator есть у auth/users/content/music/messaging.
        for m in registry() {
            assert_eq!(
                m.current_owner, "Rust",
                "{} должен принадлежать Rust",
                m.module
            );
            match m.module {
                "auth" | "users" | "content" | "music" | "messaging" | "notifications" => {
                    assert!(m.migrator.is_some(), "{}: ожидался MIGRATOR", m.module);
                }
                _ => assert!(
                    m.migrator.is_none(),
                    "{}: post-cutover миграции не зарегистрированы",
                    m.module
                ),
            }
        }
    }

    #[test]
    fn auth_migration_creates_replay_grants_table() {
        let modules = registry();
        let auth = modules
            .iter()
            .find(|module| module.module == "auth")
            .expect("auth в реестре");
        let migration = auth
            .migrator
            .expect("мигратор auth")
            .iter()
            .find(|migration| migration.description.contains("refresh replays"))
            .expect("миграция refresh_replays");
        let sql = migration.sql.as_ref();
        assert!(sql.contains("flora_core.auth_refresh_replays"));
        assert!(sql.contains("ux_auth_refresh_replays_spent_hash"));
        assert!(sql.contains("ix_auth_refresh_replays_valid_until"));
    }

    #[test]
    fn registered_migrators_are_non_empty() {
        for m in registry() {
            if let Some(migrator) = m.migrator {
                assert!(
                    migrator.iter().next().is_some(),
                    "{}: пустой каталог migrations/",
                    m.module
                );
            }
        }
    }

    #[test]
    fn messaging_migrations_include_recovery_envelopes() {
        let modules = registry();
        let messaging = modules
            .iter()
            .find(|m| m.module == "messaging")
            .expect("messaging в реестре");
        let migrator = messaging.migrator.expect("мигратор messaging");
        // sqlx превращает `_` в пробелы в description миграции.
        assert!(
            migrator
                .iter()
                .any(|m| m.description.contains("user device recovery envelopes")),
            "ожидается миграция user_device_recovery_envelopes"
        );
    }

    #[test]
    fn notifications_migration_alters_quoted_legacy_push_table() {
        let modules = registry();
        let notifications = modules
            .iter()
            .find(|module| module.module == "notifications")
            .expect("notifications в реестре");
        let migration = notifications
            .migrator
            .expect("мигратор notifications")
            .iter()
            .find(|migration| migration.description.contains("secure push previews"))
            .expect("secure push migration");
        let sql = migration.sql.as_ref();
        assert!(sql.contains("flora_core.user_push_tokens"));
        assert!(sql.contains("\"InstallationUuid\""));
        assert!(sql.contains("\"PreviewPublicKey\""));
    }
}

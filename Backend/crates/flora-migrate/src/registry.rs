//! Реестр миграций по модулям.
//!
//! Решение §11.1 (next-architecture.md): инструмент — **sqlx migrate**, история — в отдельной
//! таблице на модуль `__flora_migrations_<module>` в схеме `flora_core` (продолжение паттерна
//! `__EFMigrationsHistory_<Module>`; EF-таблицы остаются как исторические, их никто не трогает).
//!
//! Новые Rust-миграции модуля разрешены только после его cutover (§5.3): пока владелец C#,
//! `migrator` пуст (None) и flora-migrate модуль пропускает. Каждый модуль при переносе
//! объявляет `migrations/`-каталог у себя и экспортирует `sqlx::migrate!()`-Migrator,
//! который регистрируется здесь.

use sqlx::migrate::Migrator;

pub struct ModuleMigrations {
    /// Имя модуля в нижнем регистре (music, users, …).
    pub module: &'static str,
    /// Владелец по таблице статуса §6.0 — для сообщений dry-run.
    pub current_owner: &'static str,
    /// Мигратор модуля; None — модуль ещё на C#/EF, Rust-миграций нет.
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
            current_owner: "C#",
            migrator: None,
        },
        ModuleMigrations {
            module: "verification",
            current_owner: "C#",
            migrator: None,
        },
        ModuleMigrations {
            module: "auth",
            current_owner: "C#",
            migrator: None,
        },
        ModuleMigrations {
            module: "notifications",
            current_owner: "C#",
            migrator: None,
        },
        ModuleMigrations {
            module: "content",
            current_owner: "C#",
            migrator: None,
        },
        ModuleMigrations {
            module: "messaging",
            current_owner: "C#",
            migrator: None,
        },
        ModuleMigrations {
            module: "music",
            current_owner: "C#",
            migrator: None,
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
    fn phase0_has_no_rust_migrations_registered() {
        // Схема заморожена (§5.3): пока все модули на C#, Rust-миграций быть не должно.
        assert!(registry().iter().all(|m| m.migrator.is_none()));
    }
}

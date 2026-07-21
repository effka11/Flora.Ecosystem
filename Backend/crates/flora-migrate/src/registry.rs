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
//!
//! Фаза 5 выполнена (C# удалён): users/content/music объявили первые Rust-миграции
//! (§User Controls FIRA v1.1) и помечены владельцем "Rust".

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
            current_owner: "Rust",
            migrator: Some(&flora_users::MIGRATOR),
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
            current_owner: "Rust",
            migrator: Some(&flora_content::MIGRATOR),
        },
        ModuleMigrations {
            module: "messaging",
            current_owner: "C#",
            migrator: None,
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
    fn rust_migrations_registered_only_for_cutover_modules() {
        // §5.3: Rust-миграции есть только у модулей, переведённых на Rust (Фаза 5 выполнена).
        for m in registry() {
            match m.module {
                "users" | "content" | "music" => {
                    assert_eq!(m.current_owner, "Rust", "{}", m.module);
                    assert!(m.migrator.is_some(), "{}: ожидался MIGRATOR", m.module);
                }
                _ => assert!(
                    m.migrator.is_none(),
                    "{}: Rust-миграции без cutover запрещены",
                    m.module
                ),
            }
        }
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
}

//! Персонализация (FSA.md §5): контекст аффинити и блендинг.
//!
//! Ядро применяет единственную формулу:
//! `S_final = S_text × (1 + α · λ_m · A(d))`, где `A(d)` — максимум аффинити
//! по ключам документа. Инварианты: при `α = 0` множитель равен 1 бит-в-бит;
//! рост `α` монотонен; персонализация меняет только порядок уже найденных
//! документов и никогда — состав выдачи.

use std::collections::HashMap;

use fsa_contracts::AffinitySnapshot;

/// Контекст аффинити пользователя на время запроса.
/// Строится из [`AffinitySnapshot`] (мост FIRA → FSA) либо вручную.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct PersonalizationContext {
    affinity: HashMap<String, f64>,
}

impl PersonalizationContext {
    pub fn new() -> Self {
        Self::default()
    }

    /// Из снимка: веса зажимаются в `[0, 1]`, `NaN` отбрасывается,
    /// дубликаты ключей — максимум.
    pub fn from_snapshot(snapshot: &AffinitySnapshot) -> Self {
        let mut ctx = Self::new();
        for entry in &snapshot.entries {
            ctx.insert(entry.key.clone(), entry.weight);
        }
        ctx
    }

    pub fn insert(&mut self, key: impl Into<String>, weight: f64) {
        if weight.is_nan() {
            return;
        }
        let weight = weight.clamp(0.0, 1.0);
        let slot = self.affinity.entry(key.into()).or_insert(0.0);
        if weight > *slot {
            *slot = weight;
        }
    }

    pub fn is_empty(&self) -> bool {
        self.affinity.is_empty()
    }

    pub fn len(&self) -> usize {
        self.affinity.len()
    }

    /// `A(d)` — максимум аффинити по ключам документа; 0, если совпадений нет.
    pub(crate) fn affinity_max(&self, keys: &[String]) -> f64 {
        let mut best = 0.0f64;
        for key in keys {
            if let Some(w) = self.affinity.get(key)
                && *w > best
            {
                best = *w;
            }
        }
        best
    }
}

/// Персонализационный множитель `1 + α·λ·A`. Гарантия: `α = 0` → ровно `1.0`.
pub(crate) fn blend_multiplier(alpha: f64, lambda: f64, affinity: f64) -> f64 {
    if alpha == 0.0 || lambda == 0.0 || affinity == 0.0 {
        return 1.0;
    }
    1.0 + alpha * lambda * affinity
}

#[cfg(test)]
mod tests {
    use super::*;
    use fsa_contracts::{AffinityEntry, affinity_key};

    #[test]
    fn context_from_snapshot_clamps_and_dedups() {
        let snapshot = AffinitySnapshot {
            entries: vec![
                AffinityEntry {
                    key: affinity_key::author("u1"),
                    weight: 0.4,
                },
                AffinityEntry {
                    key: affinity_key::author("u1"),
                    weight: 0.9,
                },
                AffinityEntry {
                    key: affinity_key::topic("t"),
                    weight: 5.0,
                },
            ],
            generated_at: None,
        };
        let ctx = PersonalizationContext::from_snapshot(&snapshot);
        assert_eq!(ctx.len(), 2);
        assert_eq!(ctx.affinity_max(&[affinity_key::author("u1")]), 0.9);
        assert_eq!(ctx.affinity_max(&[affinity_key::topic("t")]), 1.0);
        assert_eq!(ctx.affinity_max(&["missing:x".into()]), 0.0);
    }

    #[test]
    fn blend_multiplier_invariants() {
        // α = 0 → ровно 1.0 (бит-в-бит), независимо от аффинити.
        assert_eq!(blend_multiplier(0.0, 1.0, 1.0), 1.0);
        // λ = 0 → модуль неперсонализируем.
        assert_eq!(blend_multiplier(1.0, 0.0, 1.0), 1.0);
        // Монотонность по α.
        let low = blend_multiplier(0.3, 0.8, 0.5);
        let high = blend_multiplier(0.9, 0.8, 0.5);
        assert!(high > low && low > 1.0);
        assert_eq!(blend_multiplier(1.0, 1.0, 1.0), 2.0);
    }
}

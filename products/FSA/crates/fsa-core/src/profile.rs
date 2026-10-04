//! Поисковый профиль — контракт «модуль направляет ядро» (FSA.md §6).
//! Модуль FSA-X описывает поля, веса и политику; всю работу выполняет ядро.

use fsa_contracts::SearchDomain;

use crate::error::FsaError;

/// Максимум текстовых полей профиля (FieldId — `u8`, значение 255
/// зарезервировано под атрибуты).
pub const MAX_FIELDS: usize = 32;

/// Описание одного текстового поля документа.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldSpec {
    /// Имя поля — стабильный идентификатор (используется модулем при индексации).
    pub name: &'static str,
    /// Вес поля в BM25F; > 0.
    pub weight: f64,
    /// Параметр длины BM25F `b ∈ [0, 1]`; 0.75 — стандарт.
    pub b: f64,
    /// Хранить позиции токенов (фразы, proximity). Дороже по памяти.
    pub positions: bool,
    /// Множитель точного совпадения всего поля с запросом; 0 — выключено.
    /// Применяется как `× (1 + exact_boost)` (FSA.md §4.4).
    pub exact_boost: f64,
}

impl FieldSpec {
    pub const fn new(name: &'static str, weight: f64) -> Self {
        Self {
            name,
            weight,
            b: 0.75,
            positions: false,
            exact_boost: 0.0,
        }
    }

    pub const fn positions(mut self) -> Self {
        self.positions = true;
        self
    }

    pub const fn b(mut self, b: f64) -> Self {
        self.b = b;
        self
    }

    pub const fn exact_boost(mut self, boost: f64) -> Self {
        self.exact_boost = boost;
        self
    }
}

/// Режим учёта свежести (FSA.md §4.5).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum RecencyMode {
    /// Свежесть не влияет.
    None,
    /// Мультипликативный буст: `× (1 + weight · 2^(−age/half_life))`.
    Boost { half_life_secs: i64, weight: f64 },
    /// Свежесть первична: сортировка `timestamp desc → Score desc → id asc`
    /// (уведомления). Текстовый скоринг остаётся фильтром и tie-break'ом.
    Primary,
}

/// Параметры ранжирования (FSA.md §4).
#[derive(Debug, Clone, PartialEq)]
pub struct RankingParams {
    /// BM25 `k1` — насыщение частоты терма; стандарт 1.2.
    pub k1: f64,
    /// Режим свежести.
    pub recency: RecencyMode,
    /// Вес статического приоритета документа: `× (1 + w · static_rank)`;
    /// 0 — выключено.
    pub static_rank_weight: f64,
    /// Вес proximity-бонуса за близость термов запроса (требует позиций);
    /// 0 — выключено.
    pub proximity_weight: f64,
}

impl Default for RankingParams {
    fn default() -> Self {
        Self {
            k1: 1.2,
            recency: RecencyMode::None,
            static_rank_weight: 0.0,
            proximity_weight: 0.0,
        }
    }
}

/// Политика расширения запроса (FSA.md §3).
#[derive(Debug, Clone, PartialEq)]
pub struct ExpansionPolicy {
    /// Коррекция раскладки ru↔en (вариант добавляется, только если существует
    /// в словаре индекса).
    pub layout_correction: bool,
    /// Минимальная длина токена (символы) для префиксного расширения;
    /// 0 — префиксный поиск выключен.
    pub prefix_min_chars: usize,
    /// Префикс расширяется только у последнего токена запроса (typeahead).
    pub prefix_last_token_only: bool,
    /// Максимум термов на одно префиксное расширение.
    pub prefix_max_terms: usize,
    /// Минимальная длина токена для fuzzy (d = 1); 0 — fuzzy выключен.
    pub fuzzy_min_chars: usize,
    /// Максимум fuzzy-кандидатов на токен.
    pub fuzzy_max_candidates: usize,
    /// Штраф варианта: точное совпадение = 1.0.
    pub layout_penalty: f64,
    pub prefix_penalty: f64,
    pub fuzzy_penalty: f64,
}

impl Default for ExpansionPolicy {
    fn default() -> Self {
        Self {
            layout_correction: true,
            prefix_min_chars: 3,
            prefix_last_token_only: true,
            prefix_max_terms: 64,
            fuzzy_min_chars: 4,
            fuzzy_max_candidates: 24,
            layout_penalty: 0.85,
            prefix_penalty: 0.5,
            fuzzy_penalty: 0.45,
        }
    }
}

/// Политика персонализации модуля (FSA.md §5).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PersonalizationPolicy {
    /// Потолок влияния модуля `λ_m ∈ [0, 1]`: итоговый множитель
    /// `1 + α·λ_m·A(d)`. `λ_m = 0` — модуль принципиально неперсонализируем
    /// (например, FSA-D: черновики — личные данные).
    pub lambda: f64,
}

/// Технические лимиты движка.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EngineLimits {
    /// Максимум токенов на поле документа (хвост усекается).
    pub max_field_tokens: usize,
    /// Максимум символов в терме (длиннее — усечение).
    pub max_token_chars: usize,
    /// Максимум токен-групп в запросе (хвост игнорируется).
    pub max_query_tokens: usize,
    /// Максимум окна выдачи (`offset + limit`).
    pub max_results_window: usize,
}

impl Default for EngineLimits {
    fn default() -> Self {
        Self {
            max_field_tokens: 8192,
            max_token_chars: 64,
            max_query_tokens: 16,
            max_results_window: 1000,
        }
    }
}

/// Профиль поиска — полное «рулевое управление» модуля FSA-X.
#[derive(Debug, Clone, PartialEq)]
pub struct SearchProfile {
    pub domain: SearchDomain,
    pub fields: Vec<FieldSpec>,
    pub ranking: RankingParams,
    pub expansion: ExpansionPolicy,
    pub personalization: PersonalizationPolicy,
    pub limits: EngineLimits,
}

impl SearchProfile {
    pub fn validate(&self) -> Result<(), FsaError> {
        if self.fields.is_empty() {
            return Err(FsaError::InvalidProfile {
                reason: "profile must declare at least one field".into(),
            });
        }
        if self.fields.len() > MAX_FIELDS {
            return Err(FsaError::InvalidProfile {
                reason: format!("profile declares more than {MAX_FIELDS} fields"),
            });
        }
        for (i, field) in self.fields.iter().enumerate() {
            if field.name.is_empty() {
                return Err(FsaError::InvalidProfile {
                    reason: "field name must not be empty".into(),
                });
            }
            if field.weight <= 0.0 || !field.weight.is_finite() {
                return Err(FsaError::InvalidProfile {
                    reason: format!("field `{}` weight must be finite and > 0", field.name),
                });
            }
            if !(0.0..=1.0).contains(&field.b) {
                return Err(FsaError::InvalidProfile {
                    reason: format!("field `{}` b must be within [0, 1]", field.name),
                });
            }
            if field.exact_boost < 0.0 || !field.exact_boost.is_finite() {
                return Err(FsaError::InvalidProfile {
                    reason: format!("field `{}` exact_boost must be finite and >= 0", field.name),
                });
            }
            if self.fields[..i].iter().any(|f| f.name == field.name) {
                return Err(FsaError::InvalidProfile {
                    reason: format!("duplicate field name `{}`", field.name),
                });
            }
        }
        if !(0.0..=1.0).contains(&self.personalization.lambda) {
            return Err(FsaError::InvalidProfile {
                reason: "personalization lambda must be within [0, 1]".into(),
            });
        }
        if !self.ranking.k1.is_finite() || self.ranking.k1 <= 0.0 {
            return Err(FsaError::InvalidProfile {
                reason: "k1 must be finite and > 0".into(),
            });
        }
        if self.ranking.static_rank_weight < 0.0 || self.ranking.proximity_weight < 0.0 {
            return Err(FsaError::InvalidProfile {
                reason: "ranking weights must be >= 0".into(),
            });
        }
        if let RecencyMode::Boost {
            half_life_secs,
            weight,
        } = self.ranking.recency
            && (half_life_secs <= 0 || weight < 0.0)
        {
            return Err(FsaError::InvalidProfile {
                reason: "recency boost requires half_life > 0 and weight >= 0".into(),
            });
        }
        if self.limits.max_results_window == 0 || self.limits.max_query_tokens == 0 {
            return Err(FsaError::InvalidProfile {
                reason: "limits must be > 0".into(),
            });
        }
        Ok(())
    }

    pub(crate) fn field_id(&self, name: &str) -> Option<u8> {
        self.fields
            .iter()
            .position(|f| f.name == name)
            .and_then(|i| u8::try_from(i).ok())
    }

    /// Есть ли в профиле хотя бы одно поле с позициями.
    pub(crate) fn any_positions(&self) -> bool {
        self.fields.iter().any(|f| f.positions)
    }

    /// Включён ли fuzzy-поиск (нужны deletion-сигнатуры при индексации).
    pub(crate) fn fuzzy_enabled(&self) -> bool {
        self.expansion.fuzzy_min_chars > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_profile() -> SearchProfile {
        SearchProfile {
            domain: SearchDomain::Feed,
            fields: vec![FieldSpec::new("text", 1.0)],
            ranking: RankingParams::default(),
            expansion: ExpansionPolicy::default(),
            personalization: PersonalizationPolicy { lambda: 1.0 },
            limits: EngineLimits::default(),
        }
    }

    #[test]
    fn minimal_profile_is_valid() {
        assert!(minimal_profile().validate().is_ok());
    }

    #[test]
    fn validation_rejects_bad_profiles() {
        let mut p = minimal_profile();
        p.fields.clear();
        assert!(p.validate().is_err());

        let mut p = minimal_profile();
        p.fields.push(FieldSpec::new("text", 2.0));
        assert!(p.validate().is_err(), "duplicate field name");

        let mut p = minimal_profile();
        p.fields[0].weight = 0.0;
        assert!(p.validate().is_err());

        let mut p = minimal_profile();
        p.personalization.lambda = 1.5;
        assert!(p.validate().is_err());

        let mut p = minimal_profile();
        p.ranking.recency = RecencyMode::Boost {
            half_life_secs: 0,
            weight: 0.1,
        };
        assert!(p.validate().is_err());
    }
}

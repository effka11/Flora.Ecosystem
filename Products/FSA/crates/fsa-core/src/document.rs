//! Универсальный документ индекса. Модуль FSA-X маппит доменный объект
//! (пост, трек, сообщение…) в [`Document`]; ядро о доменных типах не знает.

/// Документ для индексации. Строится билдер-цепочкой:
///
/// ```
/// use fsa_core::Document;
/// let doc = Document::new("post-1")
///     .timestamp(1_700_000_000)
///     .static_rank(0.4)
///     .field("text", "Привет, Flora!")
///     .attr("lang", "ru")
///     .personal_key(fsa_core::affinity_key::author("u-1"));
/// # let _ = doc;
/// ```
#[derive(Debug, Clone, PartialEq)]
pub struct Document {
    pub(crate) id: String,
    pub(crate) timestamp: i64,
    pub(crate) static_rank: f64,
    pub(crate) fields: Vec<(String, String)>,
    pub(crate) attrs: Vec<(String, String)>,
    pub(crate) personal_keys: Vec<String>,
}

impl Document {
    pub fn new(id: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            timestamp: 0,
            static_rank: 0.0,
            fields: Vec::new(),
            attrs: Vec::new(),
            personal_keys: Vec::new(),
        }
    }

    /// Unix-секунды; семантика (created/updated/last_active) — зона модуля.
    pub fn timestamp(mut self, ts: i64) -> Self {
        self.timestamp = ts;
        self
    }

    /// Статический приоритет качества `[0, 1]` (популярность, верификация…).
    /// Значения вне диапазона зажимаются, `NaN` → 0.
    pub fn static_rank(mut self, rank: f64) -> Self {
        self.static_rank = if rank.is_nan() {
            0.0
        } else {
            rank.clamp(0.0, 1.0)
        };
        self
    }

    /// Текстовое поле; имя должно быть объявлено в профиле движка.
    /// Повторное поле с тем же именем конкатенируется через перевод строки
    /// (удобно для тегов/множественных значений).
    pub fn field(mut self, name: impl Into<String>, text: impl Into<String>) -> Self {
        let name = name.into();
        let text = text.into();
        if let Some((_, existing)) = self.fields.iter_mut().find(|(n, _)| *n == name) {
            existing.push('\n');
            existing.push_str(&text);
        } else {
            self.fields.push((name, text));
        }
        self
    }

    /// Точный (нетокенизируемый) атрибут для фильтров: сравнение байт-в-байт.
    pub fn attr(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.attrs.push((name.into(), value.into()));
        self
    }

    /// Ключ аффинити документа (словарь — `fsa_contracts::affinity_key`).
    pub fn personal_key(mut self, key: impl Into<String>) -> Self {
        self.personal_keys.push(key.into());
        self
    }

    pub fn id(&self) -> &str {
        &self.id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_accumulates_and_clamps() {
        let doc = Document::new("d1")
            .timestamp(42)
            .static_rank(7.0)
            .field("text", "a")
            .field("text", "b")
            .field("title", "t")
            .attr("kind", "post")
            .personal_key("author:u1");
        assert_eq!(doc.id(), "d1");
        assert_eq!(doc.timestamp, 42);
        assert_eq!(doc.static_rank, 1.0);
        assert_eq!(doc.fields.len(), 2);
        assert_eq!(doc.fields[0].1, "a\nb");
        assert_eq!(Document::new("x").static_rank(f64::NAN).static_rank, 0.0);
    }
}

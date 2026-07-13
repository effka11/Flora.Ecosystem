//! Ordinal-сравнение строк с паритетом .NET `StringComparer.OrdinalIgnoreCase`.
//!
//! Эталон — `OrdinalCasing.CompareStringIgnoreCase` (dotnet/runtime, ICU-путь: Linux и
//! современный Windows): каждый code point приводится к верхнему регистру **simple**-маппингом
//! (ICU `u_toupper`, Simple_Uppercase_Mapping), суррогатная пара сравнивается как code point,
//! а «не-пара против пары» всегда даёт «не-пара меньше». Для валидных Unicode-строк это
//! эквивалентно лексикографическому сравнению последовательностей uppercased **code points** —
//! именно так и реализовано ниже. Непарные суррогаты (возможные в C#-строках) в Rust `&str`
//! непредставимы и в наших данных (Postgres text = валидный UTF-8) не встречаются.
//!
//! Нормативные потребители — tie-break'и FIRA (`docs/fira/FIRA.md` §15):
//! `Name asc` (FIRA-C), `DisplayName asc` (FIRA-P), `Title asc` (FIRA-M),
//! а также case-insensitive ключи жанровых весов FIRA-M.

use std::cmp::Ordering;

/// Simple uppercase mapping одного code point — аналог `char.ToUpperInvariant` (.NET / ICU).
///
/// `char::to_uppercase` в Rust — **full**-маппинг (SpecialCasing.txt). Согласование:
/// - full-маппинг из одного символа совпадает с simple → берём его;
/// - full-маппинг многосимвольный, simple-маппинга нет (`ß`, `ﬁ`, `ŉ`, `ΐ`…) → символ не меняется;
/// - full-маппинг многосимвольный, но simple задан — только греческие с ипогеграммени
///   (`ᾀ → ᾈ` и т.п.); закодированы явно, иначе разошлись бы с ICU/.NET.
pub fn to_upper_invariant(c: char) -> char {
    match c {
        // Греческие полифонические с ипогеграммени: full = «буква + Ι», simple = форма с
        // prosgegrammeni (U+1F88…): смещение +8 внутри каждого блока из восьми.
        '\u{1F80}'..='\u{1F87}' | '\u{1F90}'..='\u{1F97}' | '\u{1FA0}'..='\u{1FA7}' => {
            char::from_u32(c as u32 + 8).expect("сдвиг +8 в пределах блока — валидный code point")
        }
        '\u{1FB3}' => '\u{1FBC}',
        '\u{1FC3}' => '\u{1FCC}',
        '\u{1FF3}' => '\u{1FFC}',
        _ => {
            let mut up = c.to_uppercase();
            match (up.next(), up.next()) {
                (Some(single), None) => single,
                _ => c, // многосимвольное расширение → simple-маппинга нет
            }
        }
    }
}

/// Аналог `StringComparer.OrdinalIgnoreCase.Compare(a, b)` для валидных Unicode-строк.
pub fn cmp_ordinal_ignore_case(a: &str, b: &str) -> Ordering {
    a.chars()
        .map(|c| to_upper_invariant(c) as u32)
        .cmp(b.chars().map(|c| to_upper_invariant(c) as u32))
}

/// Аналог `StringComparer.OrdinalIgnoreCase.Equals(a, b)`.
pub fn eq_ordinal_ignore_case(a: &str, b: &str) -> bool {
    cmp_ordinal_ignore_case(a, b) == Ordering::Equal
}

/// Uppercase-нормализация строки simple-маппингом — ключ для case-insensitive словарей
/// (аналог `Dictionary<string, …>(StringComparer.OrdinalIgnoreCase)`):
/// `normalize(a) == normalize(b)` ⇔ `eq_ordinal_ignore_case(a, b)`.
pub fn upper_invariant_key(s: &str) -> String {
    s.chars().map(to_upper_invariant).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn latin_and_cyrillic_fold() {
        assert!(eq_ordinal_ignore_case("Flora", "fLoRa"));
        assert!(eq_ordinal_ignore_case("б", "Б"));
        assert!(eq_ordinal_ignore_case("Анна", "аННА"));
        assert!(!eq_ordinal_ignore_case("Анна", "Анно"));
    }

    #[test]
    fn ordering_matches_dotnet_tie_breaks() {
        // Кириллица после латиницы (по значениям code point), А < Б.
        assert_eq!(cmp_ordinal_ignore_case("Анна", "боб"), Ordering::Less);
        assert_eq!(
            cmp_ordinal_ignore_case("zeta garden", "Alpha Garden"),
            Ordering::Greater
        );
        // Общий префикс "AMBIENT D", дальше A < U.
        assert_eq!(
            cmp_ordinal_ignore_case("Ambient Dawn", "ambient dusk"),
            Ordering::Less
        );
        // Префикс равен → короче меньше (в .NET — lengthA − lengthB).
        assert_eq!(
            cmp_ordinal_ignore_case("alpha", "ALPHA garden"),
            Ordering::Less
        );
    }

    #[test]
    fn no_multichar_expansion_like_dotnet() {
        // char.ToUpperInvariant('ß') == 'ß': ordinal-режим не расширяет до SS.
        assert!(!eq_ordinal_ignore_case("ß", "SS"));
        assert!(!eq_ordinal_ignore_case("ß", "ẞ"));
        assert!(eq_ordinal_ignore_case("straße", "STRAßE"));
        // Микрознак µ → греческая Μ (simple-маппинг из UnicodeData).
        assert!(eq_ordinal_ignore_case("µ", "Μ"));
    }

    #[test]
    fn greek_iota_subscript_uses_simple_mapping() {
        // U+1F80 ᾀ → U+1F88 ᾈ (full дал бы двухсимвольное ἈΙ).
        assert_eq!(to_upper_invariant('\u{1F80}'), '\u{1F88}');
        assert_eq!(to_upper_invariant('\u{1FB3}'), '\u{1FBC}');
        assert!(eq_ordinal_ignore_case("\u{1F80}", "\u{1F88}"));
    }

    #[test]
    fn surrogate_pair_semantics() {
        // Deseret 𐐨/𐐀: суррогатно-осведомлённый simple-маппинг.
        assert!(eq_ordinal_ignore_case("\u{10428}", "\u{10400}"));
        // .NET: валидная суррогатная пара всегда больше любого BMP-символа,
        // даже если первый UTF-16 code unit пары (0xD801) меньше BMP-значения (0xFF3A).
        assert_eq!(
            cmp_ordinal_ignore_case("\u{FF5A}", "\u{10428}"),
            Ordering::Less
        );
    }

    #[test]
    fn dictionary_key_normalization_agrees_with_eq() {
        for (a, b) in [("rock", "ROCK"), ("Джаз", "джАз"), ("straße", "STRAßE")] {
            assert_eq!(upper_invariant_key(a), upper_invariant_key(b));
            assert!(eq_ordinal_ignore_case(a, b));
        }
        assert_ne!(upper_invariant_key("ß"), upper_invariant_key("ss"));
    }
}

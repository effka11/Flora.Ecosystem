//! Текстовый анализ FSA (FSA.md §2): нормализация FSA-N1, токенизация с
//! байтовыми смещениями, коррекция раскладки ru↔en.
//!
//! Профиль нормализации FSA-N1 — прагматичное свёртывание без внешних
//! Unicode-таблиц: lowercase, `ё → е`, срез combining-диакритик и статическая
//! таблица частых прекомпозитных латинских букв. Полный NFKD — roadmap v2;
//! смена профиля нормализации требует переиндексации (мажорная версия индекса).

/// Токен нормализованного текста. `byte_start..byte_end` — диапазон в исходной
/// (ненормализованной) строке: этого достаточно для подсветки на стороне UI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token {
    pub term: String,
    pub position: u32,
    pub byte_start: u32,
    pub byte_end: u32,
}

/// Результат свёртывания одного символа.
enum Fold {
    None,
    One(char),
    Two(char, char),
}

/// Свёртывание уже приведённого к lowercase символа (профиль FSA-N1).
fn fold_char(c: char) -> Fold {
    match c {
        // Combining diacritical marks — срезаются.
        '\u{0300}'..='\u{036F}' => Fold::None,
        // Кириллица: ё → е (нормативно для русского поиска).
        'ё' => Fold::One('е'),
        // Частые прекомпозитные латинские буквы.
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => Fold::One('a'),
        'ç' | 'ć' | 'č' => Fold::One('c'),
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' => Fold::One('e'),
        'ì' | 'í' | 'î' | 'ï' | 'ī' | 'į' => Fold::One('i'),
        'ñ' | 'ń' => Fold::One('n'),
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' => Fold::One('o'),
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ų' => Fold::One('u'),
        'ý' | 'ÿ' => Fold::One('y'),
        'š' | 'ś' => Fold::One('s'),
        'ž' | 'ź' | 'ż' => Fold::One('z'),
        'ł' => Fold::One('l'),
        'đ' => Fold::One('d'),
        'ß' => Fold::Two('s', 's'),
        'æ' => Fold::Two('a', 'e'),
        'œ' => Fold::Two('o', 'e'),
        other => Fold::One(other),
    }
}

fn push_folded(out: &mut String, c: char) {
    for lower in c.to_lowercase() {
        match fold_char(lower) {
            Fold::None => {}
            Fold::One(a) => out.push(a),
            Fold::Two(a, b) => {
                out.push(a);
                out.push(b);
            }
        }
    }
}

/// Нормализует отдельный терм (уже без разделителей) по профилю FSA-N1.
pub fn normalize_term(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for c in raw.chars() {
        if c.is_alphanumeric() {
            push_folded(&mut out, c);
        }
    }
    out
}

/// Токенизация: непрерывные последовательности alphanumeric-символов.
/// Термы длиннее `max_token_chars` усекаются (не отбрасываются: усечённый
/// префикс всё ещё матчится префиксным поиском). `max_tokens = 0` — без лимита.
pub fn tokenize(text: &str, max_tokens: usize, max_token_chars: usize) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut term = String::new();
    let mut start_byte = 0u32;
    let mut position = 0u32;

    let flush = |term: &mut String,
                 tokens: &mut Vec<Token>,
                 position: &mut u32,
                 start_byte: u32,
                 end_byte: u32| {
        if term.is_empty() {
            return;
        }
        let mut owned = std::mem::take(term);
        if max_token_chars > 0
            && let Some((cut, _)) = owned.char_indices().nth(max_token_chars)
        {
            owned.truncate(cut);
        }
        tokens.push(Token {
            term: owned,
            position: *position,
            byte_start: start_byte,
            byte_end: end_byte,
        });
        *position += 1;
    };

    for (byte_idx, c) in text.char_indices() {
        if c.is_alphanumeric() {
            if term.is_empty() {
                start_byte = u32::try_from(byte_idx).unwrap_or(u32::MAX);
            }
            push_folded(&mut term, c);
        } else {
            flush(
                &mut term,
                &mut tokens,
                &mut position,
                start_byte,
                u32::try_from(byte_idx).unwrap_or(u32::MAX),
            );
            if max_tokens > 0 && tokens.len() >= max_tokens {
                return tokens;
            }
        }
    }
    flush(
        &mut term,
        &mut tokens,
        &mut position,
        start_byte,
        u32::try_from(text.len()).unwrap_or(u32::MAX),
    );
    if max_tokens > 0 && tokens.len() > max_tokens {
        tokens.truncate(max_tokens);
    }
    tokens
}

/// en → ru: физическая клавиша QWERTY → буква ЙЦУКЕН.
fn en_char_to_ru(c: char) -> Option<char> {
    Some(match c {
        'q' => 'й',
        'w' => 'ц',
        'e' => 'у',
        'r' => 'к',
        't' => 'е',
        'y' => 'н',
        'u' => 'г',
        'i' => 'ш',
        'o' => 'щ',
        'p' => 'з',
        'a' => 'ф',
        's' => 'ы',
        'd' => 'в',
        'f' => 'а',
        'g' => 'п',
        'h' => 'р',
        'j' => 'о',
        'k' => 'л',
        'l' => 'д',
        'z' => 'я',
        'x' => 'ч',
        'c' => 'с',
        'v' => 'м',
        'b' => 'и',
        'n' => 'т',
        'm' => 'ь',
        _ => return None,
    })
}

/// ru → en: буква ЙЦУКЕН → буква на той же клавише QWERTY.
/// Буквы пунктуационных клавиш (ж, э, б, ю, х, ъ) не конвертируются —
/// пунктуация не переживает токенизацию, токен целиком дисквалифицируется.
fn ru_char_to_en(c: char) -> Option<char> {
    Some(match c {
        'й' => 'q',
        'ц' => 'w',
        'у' => 'e',
        'к' => 'r',
        'е' => 't',
        'н' => 'y',
        'г' => 'u',
        'ш' => 'i',
        'щ' => 'o',
        'з' => 'p',
        'ф' => 'a',
        'ы' => 's',
        'в' => 'd',
        'а' => 'f',
        'п' => 'g',
        'р' => 'h',
        'о' => 'j',
        'л' => 'k',
        'д' => 'l',
        'я' => 'z',
        'ч' => 'x',
        'с' => 'c',
        'м' => 'v',
        'и' => 'b',
        'т' => 'n',
        'ь' => 'm',
        _ => return None,
    })
}

/// Альтернатива токена в противоположной раскладке (FSA.md §2.4).
///
/// Токен конвертируется целиком: латиница → ЙЦУКЕН либо кириллица → QWERTY.
/// Цифры проходят без изменений. Если хотя бы один символ не конвертируется
/// (смешанные скрипты, буквы пунктуационных клавиш) — `None`.
pub fn layout_alternative(term: &str) -> Option<String> {
    let mut has_letter = false;
    let mut to_ru = None::<bool>;
    for c in term.chars() {
        if c.is_ascii_digit() {
            continue;
        }
        let dir = if c.is_ascii_lowercase() {
            true
        } else if ('а'..='я').contains(&c) {
            false
        } else {
            return None;
        };
        has_letter = true;
        match to_ru {
            None => to_ru = Some(dir),
            Some(prev) if prev != dir => return None,
            Some(_) => {}
        }
    }
    let to_ru = to_ru?;
    if !has_letter {
        return None;
    }
    let mut out = String::with_capacity(term.len() * 2);
    for c in term.chars() {
        if c.is_ascii_digit() {
            out.push(c);
            continue;
        }
        let mapped = if to_ru {
            en_char_to_ru(c)?
        } else {
            ru_char_to_en(c)?
        };
        out.push(mapped);
    }
    Some(out)
}

/// FNV-1a 64 — стабильный хеш для exact-match полей и deletion-сигнатур.
/// Не криптографический; коллизии допустимы (кандидаты верифицируются).
pub(crate) fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// Хеш полного нормализованного содержимого поля / запроса: термы,
/// соединённые `\u{1}` (разделитель вне алфавита токенов).
pub(crate) fn joined_terms_hash<'a>(terms: impl Iterator<Item = &'a str>) -> u64 {
    let mut buf = String::new();
    for (i, t) in terms.enumerate() {
        if i > 0 {
            buf.push('\u{1}');
        }
        buf.push_str(t);
    }
    fnv1a64(buf.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn terms(text: &str) -> Vec<String> {
        tokenize(text, 0, 64).into_iter().map(|t| t.term).collect()
    }

    #[test]
    fn tokenize_splits_and_lowercases() {
        assert_eq!(terms("Привет, Flora-Мир!"), vec!["привет", "flora", "мир"]);
        assert_eq!(terms("  a  b42  "), vec!["a", "b42"]);
        assert_eq!(terms(""), Vec::<String>::new());
        assert_eq!(terms("...!!!"), Vec::<String>::new());
    }

    #[test]
    fn tokenize_folds_diacritics_and_yo() {
        assert_eq!(terms("Ёлка ёж"), vec!["елка", "еж"]);
        assert_eq!(terms("Beyoncé naïve"), vec!["beyonce", "naive"]);
        assert_eq!(terms("straße"), vec!["strasse"]);
        assert_eq!(terms("Café œuvre"), vec!["cafe", "oeuvre"]);
    }

    #[test]
    fn tokenize_reports_byte_offsets_into_raw_text() {
        let text = "Ёлка и café";
        let tokens = tokenize(text, 0, 64);
        assert_eq!(tokens.len(), 3);
        assert_eq!(
            &text[tokens[0].byte_start as usize..tokens[0].byte_end as usize],
            "Ёлка"
        );
        assert_eq!(
            &text[tokens[2].byte_start as usize..tokens[2].byte_end as usize],
            "café"
        );
        assert_eq!(tokens[2].position, 2);
    }

    #[test]
    fn tokenize_respects_limits() {
        let tokens = tokenize("a b c d e", 3, 64);
        assert_eq!(tokens.len(), 3);
        let long = "x".repeat(100);
        let tokens = tokenize(&long, 0, 10);
        assert_eq!(tokens[0].term.chars().count(), 10);
    }

    #[test]
    fn normalize_term_matches_tokenizer_folding() {
        assert_eq!(normalize_term("Ёлка"), "елка");
        assert_eq!(normalize_term("Straße"), "strasse");
        assert_eq!(normalize_term("a-b"), "ab");
    }

    #[test]
    fn layout_alternative_converts_both_directions() {
        assert_eq!(layout_alternative("ghbdtn").as_deref(), Some("привет"));
        assert_eq!(layout_alternative("привет").as_deref(), Some("ghbdtn"));
        assert_eq!(layout_alternative("vfvf").as_deref(), Some("мама"));
        // Буква пунктуационной клавиши — токен не конвертируется.
        assert_eq!(layout_alternative("жук"), None);
        // Смешанные скрипты и не-ASCII латиница не конвертируются.
        assert_eq!(layout_alternative("aбв"), None);
        assert_eq!(layout_alternative("12345"), None);
        assert_eq!(layout_alternative(""), None);
    }

    #[test]
    fn fnv_hash_is_stable() {
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(
            joined_terms_hash(["hello", "world"].into_iter()),
            joined_terms_hash(["hello", "world"].into_iter())
        );
        assert_ne!(
            joined_terms_hash(["hello", "world"].into_iter()),
            joined_terms_hash(["helloworld"].into_iter())
        );
    }
}

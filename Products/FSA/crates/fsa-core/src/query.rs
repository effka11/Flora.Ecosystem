//! Разбор строки запроса (FSA.md §3.1): термы, "фразы", -исключения.
//!
//! Семантика v1: все позитивные элементы обязательны (AND); фраза требует
//! смежности позиций в одном поле; `-терм` исключает документы с термом.

use crate::text::{normalize_term, tokenize};

/// Максимальная длина фразы в токенах.
const MAX_PHRASE_TOKENS: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum QueryAtom {
    /// Одиночный токен; допускает расширения (раскладка/префикс/fuzzy).
    Term(String),
    /// Фраза: только точные термы + проверка смежности.
    Phrase(Vec<String>),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ParsedQuery {
    pub positives: Vec<QueryAtom>,
    pub negatives: Vec<String>,
}

impl ParsedQuery {
    pub fn is_empty(&self) -> bool {
        self.positives.is_empty()
    }

    /// Все позитивные токены в порядке появления (для exact-match хеша).
    pub fn flat_positive_terms(&self) -> Vec<&str> {
        let mut out = Vec::new();
        for atom in &self.positives {
            match atom {
                QueryAtom::Term(t) => out.push(t.as_str()),
                QueryAtom::Phrase(ts) => out.extend(ts.iter().map(String::as_str)),
            }
        }
        out
    }
}

/// Разбирает сырую строку запроса. `max_tokens` — лимит позитивных токенов
/// (суммарно по термам и фразам); лишнее отбрасывается.
pub(crate) fn parse(raw: &str, max_tokens: usize, max_token_chars: usize) -> ParsedQuery {
    let mut parsed = ParsedQuery::default();
    let mut token_budget = max_tokens;
    let mut rest = raw;

    while !rest.is_empty() && token_budget > 0 {
        let Some(start) = rest.find(|c: char| !c.is_whitespace()) else {
            break;
        };
        rest = &rest[start..];

        if let Some(after_quote) = rest.strip_prefix('"') {
            // Фраза до закрывающей кавычки (или до конца строки).
            let (phrase_raw, remainder) = match after_quote.find('"') {
                Some(end) => (&after_quote[..end], &after_quote[end + 1..]),
                None => (after_quote, ""),
            };
            rest = remainder;
            let mut terms: Vec<String> = tokenize(phrase_raw, MAX_PHRASE_TOKENS, max_token_chars)
                .into_iter()
                .map(|t| t.term)
                .collect();
            terms.truncate(token_budget);
            token_budget -= terms.len();
            match terms.len() {
                0 => {}
                1 => parsed.positives.push(QueryAtom::Term(terms.remove(0))),
                _ => parsed.positives.push(QueryAtom::Phrase(terms)),
            }
            continue;
        }

        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        let word = &rest[..end];
        rest = &rest[end..];

        if let Some(negated) = word.strip_prefix('-') {
            let term = normalize_term(negated);
            if !term.is_empty() {
                parsed.negatives.push(truncate_chars(term, max_token_chars));
            }
            continue;
        }
        for token in tokenize(word, token_budget, max_token_chars) {
            parsed.positives.push(QueryAtom::Term(token.term));
            token_budget -= 1;
        }
    }
    parsed
}

fn truncate_chars(mut s: String, max_chars: usize) -> String {
    if max_chars > 0
        && let Some((cut, _)) = s.char_indices().nth(max_chars)
    {
        s.truncate(cut);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse16(raw: &str) -> ParsedQuery {
        parse(raw, 16, 64)
    }

    #[test]
    fn parses_plain_terms() {
        let q = parse16("Привет  Flora");
        assert_eq!(
            q.positives,
            vec![
                QueryAtom::Term("привет".into()),
                QueryAtom::Term("flora".into())
            ]
        );
        assert!(q.negatives.is_empty());
    }

    #[test]
    fn parses_phrases_and_negations() {
        let q = parse16("\"новый альбом\" рок -поп");
        assert_eq!(
            q.positives,
            vec![
                QueryAtom::Phrase(vec!["новый".into(), "альбом".into()]),
                QueryAtom::Term("рок".into()),
            ]
        );
        assert_eq!(q.negatives, vec!["поп".to_string()]);
    }

    #[test]
    fn single_token_phrase_becomes_term() {
        let q = parse16("\"rust\"");
        assert_eq!(q.positives, vec![QueryAtom::Term("rust".into())]);
    }

    #[test]
    fn unterminated_phrase_and_lone_minus_are_tolerated() {
        let q = parse16("\"open phrase");
        assert_eq!(
            q.positives,
            vec![QueryAtom::Phrase(vec!["open".into(), "phrase".into()])]
        );
        let q = parse16("- -- a");
        assert_eq!(q.positives, vec![QueryAtom::Term("a".into())]);
        assert!(q.negatives.is_empty());
    }

    #[test]
    fn respects_token_budget() {
        let q = parse("a b c d e", 3, 64);
        assert_eq!(q.positives.len(), 3);
        let q = parse("\"a b c d e\"", 3, 64);
        assert_eq!(
            q.positives,
            vec![QueryAtom::Phrase(vec!["a".into(), "b".into(), "c".into()])]
        );
    }

    #[test]
    fn flat_positive_terms_flattens_in_order() {
        let q = parse16("\"a b\" c");
        assert_eq!(q.flat_positive_terms(), vec!["a", "b", "c"]);
    }

    #[test]
    fn empty_and_punctuation_queries() {
        assert!(parse16("").is_empty());
        assert!(parse16("   ...   ").is_empty());
        assert!(parse16("\"\"").is_empty());
    }
}

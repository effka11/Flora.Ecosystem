//! Нечёткое сопоставление (FSA.md §2.5): кандидаты через deletion-сигнатуры
//! (SymSpell, d = 1) + верификация ограниченным расстоянием
//! Дамерау—Левенштейна (OSA). Точность важнее охвата: кандидат без
//! верификации в выдачу не попадает.

use crate::text::fnv1a64;

/// Максимальная длина терма (в символах), для которого строятся
/// deletion-сигнатуры. Более длинные термы ищутся только точно/префиксно.
pub(crate) const MAX_SIGNATURE_CHARS: usize = 24;

/// `true`, если расстояние Дамерау—Левенштейна (optimal string alignment)
/// между `a` и `b` не превышает `max_d`.
pub(crate) fn within_distance(a: &str, b: &str, max_d: usize) -> bool {
    if a == b {
        return true;
    }
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (n, m) = (a.len(), b.len());
    if n.abs_diff(m) > max_d {
        return false;
    }
    if n == 0 || m == 0 {
        return n.max(m) <= max_d;
    }

    // OSA DP: prev2 / prev / current строки матрицы.
    let mut prev2 = vec![0usize; m + 1];
    let mut prev: Vec<usize> = (0..=m).collect();
    let mut cur = vec![0usize; m + 1];

    for i in 1..=n {
        cur[0] = i;
        let mut row_min = cur[0];
        for j in 1..=m {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            let mut d = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                d = d.min(prev2[j - 2] + 1);
            }
            cur[j] = d;
            row_min = row_min.min(d);
        }
        if row_min > max_d {
            return false;
        }
        std::mem::swap(&mut prev2, &mut prev);
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[m] <= max_d
}

/// Хеши всех строк, получаемых удалением одного символа из `term`
/// (сигнатуры SymSpell d = 1). Для термов длиной 1 или длиннее
/// [`MAX_SIGNATURE_CHARS`] сигнатуры не строятся.
pub(crate) fn deletion_hashes(term: &str) -> Vec<u64> {
    let chars: Vec<char> = term.chars().collect();
    let len = chars.len();
    if !(2..=MAX_SIGNATURE_CHARS).contains(&len) {
        return Vec::new();
    }
    let mut hashes = Vec::with_capacity(len);
    let mut buf = String::with_capacity(term.len());
    for skip in 0..len {
        buf.clear();
        for (i, c) in chars.iter().enumerate() {
            if i != skip {
                buf.push(*c);
            }
        }
        hashes.push(fnv1a64(buf.as_bytes()));
    }
    hashes.sort_unstable();
    hashes.dedup();
    hashes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn within_distance_basic() {
        assert!(within_distance("metallica", "metallica", 1));
        assert!(within_distance("metalica", "metallica", 1)); // deletion
        assert!(within_distance("metallicca", "metallica", 1)); // insertion
        assert!(within_distance("metallika", "metallica", 1)); // substitution
        assert!(within_distance("metallcia", "metallica", 1)); // transposition
        assert!(!within_distance("metalika", "metallica", 1)); // d = 2
        assert!(within_distance("metalika", "metallica", 2));
        assert!(!within_distance("cat", "dog", 2));
        assert!(within_distance("", "a", 1));
        assert!(!within_distance("", "ab", 1));
    }

    #[test]
    fn within_distance_handles_cyrillic() {
        assert!(within_distance("привет", "привт", 1));
        assert!(within_distance("превит", "привет", 2));
        assert!(!within_distance("превит", "привет", 1));
    }

    #[test]
    fn deletion_hashes_cover_symspell_d1() {
        // "кот" и "кто" (транспозиция) делят сигнатуру "кт".
        let a = deletion_hashes("кот");
        let b = deletion_hashes("кто");
        assert!(a.iter().any(|h| b.contains(h)));
        // Терм длиной 1 и сверхдлинные термы — без сигнатур.
        assert!(deletion_hashes("a").is_empty());
        assert!(deletion_hashes(&"x".repeat(MAX_SIGNATURE_CHARS + 1)).is_empty());
    }
}

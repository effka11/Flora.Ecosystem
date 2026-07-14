//! Парсер artist display — паритет с MusicArtistDisplayParser (C#).
//!
//! Квирк C#: найденный joiner записывается в **предыдущий** сегмент
//! (`JoinerBefore`), а не в следующий. Нераспознанный joiner → `0` (None),
//! как `MapBackfillJoiner` / backfill (`Unrecognized` → `None`).

use super::artist_name;

/// Сегмент имени; `joiner_before` — i32 как `credits::joiner` / `TrackArtistJoiner`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSegment {
    pub display_name: String,
    pub joiner_before: i32,
}

/// Ordinals совпадают с `application::credits::joiner` и C# `TrackArtistJoiner`.
mod joiner_id {
    pub const NONE: i32 = 0;
    pub const AND: i32 = 1;
    pub const FT: i32 = 2;
    pub const VS: i32 = 3;
    pub const PROD: i32 = 4;
    pub const MIX: i32 = 5;
    pub const REMIX: i32 = 6;
    pub const EDIT: i32 = 7;
    pub const PRES: i32 = 8;
}

/// Порядок как в C# `MusicArtistDisplayParser.Joiners` (сначала double-space).
const JOINERS: &[(&str, i32)] = &[
    ("  &  ", joiner_id::AND),
    ("  ft.  ", joiner_id::FT),
    ("  vs.  ", joiner_id::VS),
    ("  prod.  ", joiner_id::PROD),
    ("  mix.  ", joiner_id::MIX),
    ("  remix  ", joiner_id::REMIX),
    ("  edit.  ", joiner_id::EDIT),
    ("  pres.  ", joiner_id::PRES),
    (" feat. ", joiner_id::FT),
    (" & ", joiner_id::AND),
    (" ft. ", joiner_id::FT),
    (" vs. ", joiner_id::VS),
    (" prod. ", joiner_id::PROD),
    (" mix. ", joiner_id::MIX),
    (" remix ", joiner_id::REMIX),
    (" edit. ", joiner_id::EDIT),
    (" pres. ", joiner_id::PRES),
];

/// `MusicArtistDisplayParser.Parse` — 1:1, включая assign joiner → previous segment.
pub fn parse(artist_display: &str) -> Vec<ParsedSegment> {
    if artist_display.trim().is_empty() {
        return Vec::new();
    }

    let value = artist_display;
    let mut segments: Vec<ParsedSegment> = Vec::new();
    let mut index = 0usize;

    while index <= value.len() {
        let mut earliest: Option<(&str, i32)> = None;
        let mut earliest_at = value.len();

        for &(text, id) in JOINERS {
            if let Some(at) = find_ordinal_ignore_case(value, text, index)
                && at < earliest_at
            {
                earliest = Some((text, id));
                earliest_at = at;
            }
        }

        let chunk_end = if earliest.is_some() {
            earliest_at
        } else {
            value.len()
        };

        if chunk_end > index {
            let name = value[index..chunk_end].trim();
            if artist_name::is_valid_display_name(name) {
                // C#: first → None, later → Unrecognized; both persist as credits::joiner::NONE (0).
                segments.push(ParsedSegment {
                    display_name: name.to_string(),
                    joiner_before: joiner_id::NONE,
                });
            }
        }

        let Some((earliest_text, earliest_id)) = earliest else {
            break;
        };

        if !segments.is_empty() {
            let last = segments.len() - 1;
            segments[last].joiner_before = earliest_id;
        }

        index = earliest_at + earliest_text.len();
    }

    segments
}

/// `StringComparison.OrdinalIgnoreCase` для ASCII-joiner'ов (как в C# списке).
fn find_ordinal_ignore_case(haystack: &str, needle: &str, from: usize) -> Option<usize> {
    if from > haystack.len() || !haystack.is_char_boundary(from) {
        return None;
    }
    let hay = &haystack[from..];
    let nlen = needle.len();
    if nlen == 0 || hay.len() < nlen {
        return None;
    }

    let needle_bytes = needle.as_bytes();
    for i in 0..=hay.len() - nlen {
        if !hay.is_char_boundary(i) || !hay.is_char_boundary(i + nlen) {
            continue;
        }
        let slice = hay.as_bytes();
        let mut ok = true;
        for j in 0..nlen {
            if !slice[i + j].eq_ignore_ascii_case(&needle_bytes[j]) {
                ok = false;
                break;
            }
        }
        if ok {
            return Some(from + i);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use joiner_id::*;

    fn names_joiners(segs: &[ParsedSegment]) -> Vec<(&str, i32)> {
        segs.iter()
            .map(|s| (s.display_name.as_str(), s.joiner_before))
            .collect()
    }

    #[test]
    fn empty_and_whitespace() {
        assert!(parse("").is_empty());
        assert!(parse("   ").is_empty());
        assert!(parse("\t\n").is_empty());
    }

    #[test]
    fn single_artist() {
        assert_eq!(names_joiners(&parse("Solo")), vec![("Solo", NONE)]);
        assert_eq!(names_joiners(&parse("  Flora Artist  ")), vec![("Flora Artist", NONE)]);
    }

    #[test]
    fn and_joiner_assigned_to_previous() {
        // Quirk: "&" lands on A, B keeps Unrecognized→None
        assert_eq!(
            names_joiners(&parse("A & B")),
            vec![("A", AND), ("B", NONE)]
        );
        assert_eq!(
            names_joiners(&parse("A  &  B")),
            vec![("A", AND), ("B", NONE)]
        );
    }

    #[test]
    fn ft_and_feat() {
        assert_eq!(
            names_joiners(&parse("A ft. B")),
            vec![("A", FT), ("B", NONE)]
        );
        assert_eq!(
            names_joiners(&parse("A feat. B")),
            vec![("A", FT), ("B", NONE)]
        );
        assert_eq!(
            names_joiners(&parse("A  ft.  B")),
            vec![("A", FT), ("B", NONE)]
        );
    }

    #[test]
    fn ordinal_ignore_case() {
        assert_eq!(
            names_joiners(&parse("A FT. B")),
            vec![("A", FT), ("B", NONE)]
        );
        assert_eq!(
            names_joiners(&parse("A Vs. B")),
            vec![("A", VS), ("B", NONE)]
        );
        assert_eq!(
            names_joiners(&parse("A REMIX B")),
            vec![("A", REMIX), ("B", NONE)]
        );
    }

    #[test]
    fn chain_of_joiners() {
        assert_eq!(
            names_joiners(&parse("A & B vs. C")),
            vec![("A", AND), ("B", VS), ("C", NONE)]
        );
        assert_eq!(
            names_joiners(&parse("A prod. B remix C")),
            vec![("A", PROD), ("B", REMIX), ("C", NONE)]
        );
    }

    #[test]
    fn all_joiner_kinds() {
        assert_eq!(names_joiners(&parse("A mix. B"))[0].1, MIX);
        assert_eq!(names_joiners(&parse("A edit. B"))[0].1, EDIT);
        assert_eq!(names_joiners(&parse("A pres. B"))[0].1, PRES);
    }

    #[test]
    fn skips_empty_chunks_between_joiners() {
        // Leading joiner with no name before it: empty chunk skipped.
        assert_eq!(names_joiners(&parse(" & B")), vec![("B", NONE)]);
    }
}

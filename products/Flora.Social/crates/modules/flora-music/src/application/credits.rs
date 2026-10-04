//! Credit attach helpers — паритет с MusicArtistCreditValidator / RoleResolver /
//! DisplayComposer / MusicArtistControllerHelpers.ParseArtistCredits.

use serde_json::Value;
use uuid::Uuid;

/// `TrackArtistJoiner` (domain i32).
pub mod joiner {
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

/// `TrackArtistRole` (domain i32).
pub mod role {
    pub const PRIMARY: i32 = 0;
    pub const FEATURED: i32 = 1;
    pub const PRODUCER: i32 = 2;
    pub const REMIXER: i32 = 3;
    pub const OTHER: i32 = 4;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CreditInput {
    pub artist_uuid: Uuid,
    pub joiner_before: i32,
}

/// `MusicArtistCreditValidator.ValidateUploadCredits`.
pub fn validate_upload_credits(credits: &[CreditInput]) -> Option<&'static str> {
    if credits.is_empty() {
        return Some("Укажите хотя бы одного исполнителя.");
    }

    for (i, credit) in credits.iter().enumerate() {
        if i == 0 {
            if credit.joiner_before != joiner::NONE {
                return Some("У первого исполнителя не должно быть разделителя.");
            }
        } else if credit.joiner_before == joiner::NONE {
            return Some("Укажите способ добавления для каждого исполнителя после первого.");
        }
    }

    None
}

/// `MusicArtistCreditRoleResolver.Resolve`.
pub fn resolve_role(joiner_before: i32, index: usize) -> i32 {
    if index == 0 {
        role::PRIMARY
    } else {
        resolve_role_from_joiner(joiner_before)
    }
}

/// `MusicArtistCreditRoleResolver.ResolveFromJoiner`.
pub fn resolve_role_from_joiner(joiner_before: i32) -> i32 {
    match joiner_before {
        joiner::FT => role::FEATURED,
        joiner::AND => role::PRIMARY,
        joiner::PROD => role::PRODUCER,
        joiner::REMIX => role::REMIXER,
        joiner::VS | joiner::MIX | joiner::EDIT | joiner::PRES => role::OTHER,
        _ => role::PRIMARY,
    }
}

/// `MusicArtistDisplayComposer.Compose`.
pub fn compose_display(credits: &[(String, i32)]) -> String {
    if credits.is_empty() {
        return String::new();
    }

    let mut parts = Vec::new();
    for (i, (name, joiner_before)) in credits.iter().enumerate() {
        if i > 0 {
            parts.push(joiner_text(*joiner_before).to_string());
        }
        parts.push(name.clone());
    }
    parts.concat()
}

fn joiner_text(joiner_before: i32) -> &'static str {
    match joiner_before {
        joiner::AND => "  &  ",
        joiner::FT => "  ft.  ",
        joiner::VS => "  vs.  ",
        joiner::PROD => "  prod.  ",
        joiner::MIX => "  mix.  ",
        joiner::REMIX => "  remix  ",
        joiner::EDIT => "  edit.  ",
        joiner::PRES => "  pres.  ",
        _ => "",
    }
}

/// `MusicArtistControllerHelpers.ParseArtistCredits` — bad JSON → empty vec.
///
/// `joinerBefore`: case-insensitive enum name string **or** int.
pub fn parse_artist_credits(artist_credits_json: Option<&str>) -> Vec<CreditInput> {
    let Some(raw) = artist_credits_json.map(str::trim).filter(|s| !s.is_empty()) else {
        return Vec::new();
    };

    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    let Some(arr) = value.as_array() else {
        return Vec::new();
    };
    if arr.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::with_capacity(arr.len());
    for item in arr {
        let Some(obj) = item.as_object() else {
            return Vec::new();
        };
        let uuid_val = obj
            .get("artistUuid")
            .or_else(|| obj.get("ArtistUuid"))
            .or_else(|| obj.get("artist_uuid"));
        let joiner_val = obj
            .get("joinerBefore")
            .or_else(|| obj.get("JoinerBefore"))
            .or_else(|| obj.get("joiner_before"));

        let Some(uuid_val) = uuid_val else {
            return Vec::new();
        };
        let artist_uuid = match uuid_val {
            Value::String(s) => match Uuid::parse_str(s) {
                Ok(u) => u,
                Err(_) => return Vec::new(),
            },
            _ => return Vec::new(),
        };

        let joiner_before = match joiner_val {
            None => joiner::NONE,
            Some(v) => match parse_joiner_value(v) {
                Some(j) => j,
                None => return Vec::new(),
            },
        };

        out.push(CreditInput {
            artist_uuid,
            joiner_before,
        });
    }
    out
}

fn parse_joiner_value(v: &Value) -> Option<i32> {
    match v {
        Value::Number(n) => {
            let i = n.as_i64()?;
            // System.Text.Json rejects undefined enum ints → JsonException → [].
            if (0..=8).contains(&i) {
                Some(i as i32)
            } else {
                None
            }
        }
        Value::String(s) => parse_joiner_name(s),
        _ => None,
    }
}

fn parse_joiner_name(s: &str) -> Option<i32> {
    Some(match s.trim().to_ascii_lowercase().as_str() {
        "none" => joiner::NONE,
        "and" => joiner::AND,
        "ft" => joiner::FT,
        "vs" => joiner::VS,
        "prod" => joiner::PROD,
        "mix" => joiner::MIX,
        "remix" => joiner::REMIX,
        "edit" => joiner::EDIT,
        "pres" => joiner::PRES,
        _ => return None,
    })
}

/// `MusicArtistControllerHelpers.MapJoiner` — unknown → None.
pub fn map_joiner(joiner_before: i32) -> i32 {
    match joiner_before {
        joiner::AND => joiner::AND,
        joiner::FT => joiner::FT,
        joiner::VS => joiner::VS,
        joiner::PROD => joiner::PROD,
        joiner::MIX => joiner::MIX,
        joiner::REMIX => joiner::REMIX,
        joiner::EDIT => joiner::EDIT,
        joiner::PRES => joiner::PRES,
        _ => joiner::NONE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uuid(n: u128) -> Uuid {
        Uuid::from_u128(n)
    }

    #[test]
    fn validate_upload_credits_messages() {
        assert_eq!(
            validate_upload_credits(&[]),
            Some("Укажите хотя бы одного исполнителя.")
        );
        assert_eq!(
            validate_upload_credits(&[CreditInput {
                artist_uuid: uuid(1),
                joiner_before: joiner::AND,
            }]),
            Some("У первого исполнителя не должно быть разделителя.")
        );
        assert_eq!(
            validate_upload_credits(&[
                CreditInput {
                    artist_uuid: uuid(1),
                    joiner_before: joiner::NONE,
                },
                CreditInput {
                    artist_uuid: uuid(2),
                    joiner_before: joiner::NONE,
                },
            ]),
            Some("Укажите способ добавления для каждого исполнителя после первого.")
        );
        assert_eq!(
            validate_upload_credits(&[
                CreditInput {
                    artist_uuid: uuid(1),
                    joiner_before: joiner::NONE,
                },
                CreditInput {
                    artist_uuid: uuid(2),
                    joiner_before: joiner::FT,
                },
            ]),
            None
        );
    }

    #[test]
    fn resolve_roles() {
        assert_eq!(resolve_role(joiner::FT, 0), role::PRIMARY);
        assert_eq!(resolve_role(joiner::FT, 1), role::FEATURED);
        assert_eq!(resolve_role_from_joiner(joiner::AND), role::PRIMARY);
        assert_eq!(resolve_role_from_joiner(joiner::PROD), role::PRODUCER);
        assert_eq!(resolve_role_from_joiner(joiner::REMIX), role::REMIXER);
        assert_eq!(resolve_role_from_joiner(joiner::VS), role::OTHER);
        assert_eq!(resolve_role_from_joiner(joiner::MIX), role::OTHER);
        assert_eq!(resolve_role_from_joiner(joiner::NONE), role::PRIMARY);
    }

    #[test]
    fn compose_joiners() {
        assert_eq!(compose_display(&[]), "");
        assert_eq!(
            compose_display(&[("A".into(), joiner::NONE), ("B".into(), joiner::AND)]),
            "A  &  B"
        );
        assert_eq!(
            compose_display(&[
                ("A".into(), joiner::NONE),
                ("B".into(), joiner::FT),
                ("C".into(), joiner::VS),
            ]),
            "A  ft.  B  vs.  C"
        );
        assert_eq!(
            compose_display(&[("A".into(), joiner::NONE), ("B".into(), joiner::REMIX)]),
            "A  remix  B"
        );
        assert_eq!(
            compose_display(&[("A".into(), joiner::NONE), ("B".into(), joiner::PROD)]),
            "A  prod.  B"
        );
    }

    #[test]
    fn parse_artist_credits_json() {
        let a = "11111111-1111-1111-1111-111111111111";
        let b = "22222222-2222-2222-2222-222222222222";

        assert!(parse_artist_credits(None).is_empty());
        assert!(parse_artist_credits(Some("")).is_empty());
        assert!(parse_artist_credits(Some("not-json")).is_empty());

        let parsed = parse_artist_credits(Some(&format!(
            r#"[{{"artistUuid":"{a}","joinerBefore":0}},{{"artistUuid":"{b}","joinerBefore":"ft"}}]"#
        )));
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].artist_uuid, Uuid::parse_str(a).unwrap());
        assert_eq!(parsed[0].joiner_before, joiner::NONE);
        assert_eq!(parsed[1].joiner_before, joiner::FT);

        let parsed_int = parse_artist_credits(Some(&format!(
            r#"[{{"ArtistUuid":"{a}","JoinerBefore":2}}]"#
        )));
        assert_eq!(parsed_int.len(), 1);
        assert_eq!(parsed_int[0].joiner_before, joiner::FT);

        let parsed_case = parse_artist_credits(Some(&format!(
            r#"[{{"artistUuid":"{a}","joinerBefore":"ReMiX"}}]"#
        )));
        assert_eq!(parsed_case[0].joiner_before, joiner::REMIX);
    }
}

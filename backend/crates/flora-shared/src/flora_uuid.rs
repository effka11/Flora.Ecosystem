//! UUID v7 (RFC 9562, time-ordered). Порт `Flora.Shared/FloraUuid.cs`.
//! Для детерминированных id — [`crate::uuid_v5`].

use uuid::Uuid;

/// Аналог `FloraUuid.NewGuid()` — новый time-ordered идентификатор.
pub fn new_uuid() -> Uuid {
    Uuid::now_v7()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_version_7_rfc_variant() {
        let id = new_uuid();
        assert_eq!(id.get_version_num(), 7);
        assert_eq!(id.get_variant(), uuid::Variant::RFC4122);
    }

    #[test]
    fn string_form_is_lowercase_hyphenated() {
        let s = new_uuid().to_string();
        assert_eq!(s.len(), 36);
        assert_eq!(s, s.to_lowercase());
        assert_eq!(s.matches('-').count(), 4);
    }

    #[test]
    fn timestamps_are_monotonic_across_calls() {
        let a = new_uuid();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let b = new_uuid();
        assert!(a.as_bytes() < b.as_bytes(), "v7 must be time-ordered");
    }
}

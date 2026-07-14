//! Паритет с `MusicUploadValidation.cs` — лимиты и pre-filter для upload.

/// 70 MiB.
pub const MAX_AUDIO_BYTES: i64 = 70 * 1024 * 1024;
/// 5 MiB.
pub const MAX_COVER_BYTES: i64 = 5 * 1024 * 1024;

const ALLOWED_AUDIO_CONTENT_TYPES: &[&str] = &[
    "audio/mpeg",
    "audio/mp3",
    "audio/mp4",
    "audio/x-m4a",
    "audio/m4a",
    "audio/aac",
    "audio/flac",
    "audio/wav",
    "audio/x-wav",
    "audio/ogg",
    "audio/opus",
    "audio/webm",
    "audio/x-ms-wma",
    "audio/aiff",
    "audio/x-aiff",
];

const ALLOWED_AUDIO_EXTENSIONS: &[&str] = &[
    ".mp3", ".m4a", ".mp4", ".aac", ".flac", ".wav", ".ogg", ".opus", ".webm", ".wma", ".aiff",
    ".aif",
];

const ALLOWED_LICENSE_IDS: &[&str] = &[
    "all_rights_reserved",
    "cc_by",
    "cc_by_nc",
    "cc_by_nd",
    "cc_by_nc_nd",
    "cc0",
];

fn eq_ignore_ascii_case(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

fn set_contains_ignore_case(haystack: &[&str], needle: &str) -> bool {
    haystack
        .iter()
        .any(|item| eq_ignore_ascii_case(item, needle))
}

/// `MusicUploadValidation.ValidateAudio`.
pub fn validate_audio(
    content_type: Option<&str>,
    file_name: Option<&str>,
    length: i64,
) -> Option<&'static str> {
    if length <= 0 {
        return Some("Файл пуст.");
    }
    if length > MAX_AUDIO_BYTES {
        return Some("Размер файла не должен превышать 70 МБ.");
    }

    let normalized_type = normalize_content_type(content_type);
    let has_known_extension = has_allowed_audio_extension(file_name);

    if !normalized_type.trim().is_empty() {
        if set_contains_ignore_case(ALLOWED_AUDIO_CONTENT_TYPES, &normalized_type) {
            return None;
        }
        if eq_ignore_ascii_case(&normalized_type, "application/octet-stream") && has_known_extension
        {
            return None;
        }
        return Some("Нужен поддерживаемый аудиофайл (MP3, M4A, FLAC, WAV и др.).");
    }
    if has_known_extension {
        return None;
    }

    Some("Нужен поддерживаемый аудиофайл (MP3, M4A, FLAC, WAV и др.).")
}

/// `MusicUploadValidation.HasAllowedAudioExtension`.
pub fn has_allowed_audio_extension(file_name: Option<&str>) -> bool {
    let Some(name) = file_name.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    let ext = extension(name);
    !ext.is_empty() && set_contains_ignore_case(ALLOWED_AUDIO_EXTENSIONS, ext)
}

fn extension(file_name: &str) -> &str {
    // Path.GetExtension: last '.' after last separator; includes the dot.
    let base = file_name.rsplit(['/', '\\']).next().unwrap_or(file_name);
    match base.rfind('.') {
        Some(0) => "",
        Some(i) if i + 1 < base.len() => &base[i..],
        Some(i) => &base[i..],
        None => "",
    }
}

/// `MusicUploadValidation.ValidateCover`.
pub fn validate_cover(content_type: Option<&str>, length: i64) -> Option<&'static str> {
    if length <= 0 {
        return Some("Обложка пуста.");
    }
    if length > MAX_COVER_BYTES {
        return Some("Обложка слишком большая (макс. 5 МБ).");
    }

    let normalized_type = normalize_content_type(content_type);
    if normalized_type.trim().is_empty()
        || !normalized_type.to_ascii_lowercase().starts_with("image/")
    {
        return Some("Обложка должна быть изображением.");
    }

    None
}

/// `MusicUploadValidation.ValidateLicenseId`.
pub fn validate_license_id(license_id: Option<&str>) -> Option<&'static str> {
    let Some(id) = license_id.map(str::trim).filter(|s| !s.is_empty()) else {
        return Some("Выберите лицензию.");
    };
    if !set_contains_ignore_case(ALLOWED_LICENSE_IDS, id) {
        return Some("Выберите лицензию.");
    }
    None
}

/// `MusicUploadValidation.NormalizeContentType`.
pub fn normalize_content_type(content_type: Option<&str>) -> String {
    let Some(raw) = content_type.map(str::trim).filter(|s| !s.is_empty()) else {
        return String::new();
    };
    raw.split(';').next().unwrap_or("").trim().to_string()
}

/// `MusicUploadValidation.NormalizeTitle`.
pub fn normalize_title(title: Option<&str>) -> String {
    match title.map(str::trim).filter(|s| !s.is_empty()) {
        Some(t) => t.to_string(),
        None => "Без названия".to_string(),
    }
}

/// `MusicUploadValidation.NormalizeArtist`.
pub fn normalize_artist(artist: Option<&str>) -> String {
    match artist.map(str::trim).filter(|s| !s.is_empty()) {
        Some(a) => a.to_string(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_audio_empty_and_too_large() {
        assert_eq!(
            validate_audio(Some("audio/mpeg"), Some("a.mp3"), 0),
            Some("Файл пуст.")
        );
        assert_eq!(
            validate_audio(Some("audio/mpeg"), Some("a.mp3"), MAX_AUDIO_BYTES + 1),
            Some("Размер файла не должен превышать 70 МБ.")
        );
    }

    #[test]
    fn validate_audio_allowlisted_mime_and_octet_stream() {
        assert_eq!(validate_audio(Some("audio/mpeg"), Some("a.bin"), 100), None);
        assert_eq!(
            validate_audio(Some("application/octet-stream"), Some("track.flac"), 100),
            None
        );
        assert_eq!(
            validate_audio(Some("application/octet-stream"), Some("track.txt"), 100),
            Some("Нужен поддерживаемый аудиофайл (MP3, M4A, FLAC, WAV и др.).")
        );
        assert_eq!(
            validate_audio(Some("text/plain"), Some("a.mp3"), 100),
            Some("Нужен поддерживаемый аудиофайл (MP3, M4A, FLAC, WAV и др.).")
        );
        assert_eq!(validate_audio(None, Some("song.MP3"), 100), None);
        assert_eq!(
            validate_audio(None, Some("song.txt"), 100),
            Some("Нужен поддерживаемый аудиофайл (MP3, M4A, FLAC, WAV и др.).")
        );
    }

    #[test]
    fn validate_cover_and_license() {
        assert_eq!(validate_cover(Some("image/png"), 0), Some("Обложка пуста."));
        assert_eq!(
            validate_cover(Some("image/png"), MAX_COVER_BYTES + 1),
            Some("Обложка слишком большая (макс. 5 МБ).")
        );
        assert_eq!(
            validate_cover(Some("audio/mpeg"), 10),
            Some("Обложка должна быть изображением.")
        );
        assert_eq!(validate_cover(Some("image/jpeg"), 10), None);
        assert_eq!(validate_license_id(None), Some("Выберите лицензию."));
        assert_eq!(validate_license_id(Some("cc_by")), None);
        assert_eq!(validate_license_id(Some("CC0")), None);
        assert_eq!(
            validate_license_id(Some("nope")),
            Some("Выберите лицензию.")
        );
    }

    #[test]
    fn normalize_helpers() {
        assert_eq!(
            normalize_content_type(Some("audio/mpeg; codecs=mp3")),
            "audio/mpeg"
        );
        assert_eq!(normalize_title(None), "Без названия");
        assert_eq!(normalize_title(Some("  Hi  ")), "Hi");
        assert_eq!(normalize_artist(None), "");
        assert_eq!(normalize_artist(Some("  A  ")), "A");
    }
}

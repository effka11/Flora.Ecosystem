namespace Flora.Music.Application.Tracks;

public static class MusicUploadValidation
{
    public const long MaxAudioBytes = 70L * 1024 * 1024;
    public const long MaxCoverBytes = 5L * 1024 * 1024;

    private static readonly HashSet<string> AllowedAudioContentTypes = new(StringComparer.OrdinalIgnoreCase)
    {
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
    };

    private static readonly HashSet<string> AllowedAudioExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mp3", ".m4a", ".mp4", ".aac", ".flac", ".wav", ".ogg", ".opus", ".webm", ".wma", ".aiff", ".aif",
    };

    private static readonly HashSet<string> AllowedLicenseIds = new(StringComparer.OrdinalIgnoreCase)
    {
        "all_rights_reserved",
        "cc_by",
        "cc_by_nc",
        "cc_by_nd",
        "cc_by_nc_nd",
        "cc0",
    };

    public static string? ValidateAudio(string? contentType, string? fileName, long length)
    {
        if (length <= 0)
            return "Файл пуст.";
        if (length > MaxAudioBytes)
            return "Размер файла не должен превышать 70 МБ.";

        var normalizedType = NormalizeContentType(contentType);
        var hasKnownExtension = HasAllowedAudioExtension(fileName);

        // Narrowed pre-filter: only an explicitly allow-listed audio MIME, or a generic
        // application/octet-stream paired with a known audio extension (some browsers send that for
        // FLAC/OPUS). The arbitrary "any audio/*" acceptance is gone — the ffmpeg probe/transcode is
        // the authoritative content check and rejects anything that is not real audio.
        if (!string.IsNullOrWhiteSpace(normalizedType))
        {
            if (AllowedAudioContentTypes.Contains(normalizedType))
                return null;
            if (string.Equals(normalizedType, "application/octet-stream", StringComparison.OrdinalIgnoreCase)
                && hasKnownExtension)
                return null;
            return "Нужен поддерживаемый аудиофайл (MP3, M4A, FLAC, WAV и др.).";
        }
        if (hasKnownExtension)
            return null;

        return "Нужен поддерживаемый аудиофайл (MP3, M4A, FLAC, WAV и др.).";
    }

    public static bool HasAllowedAudioExtension(string? fileName)
    {
        if (string.IsNullOrWhiteSpace(fileName))
            return false;
        var ext = Path.GetExtension(fileName);
        return !string.IsNullOrWhiteSpace(ext) && AllowedAudioExtensions.Contains(ext);
    }

    public static string? ValidateCover(string? contentType, long length)
    {
        if (length <= 0)
            return "Обложка пуста.";
        if (length > MaxCoverBytes)
            return "Обложка слишком большая (макс. 5 МБ).";

        var normalizedType = NormalizeContentType(contentType);
        if (string.IsNullOrWhiteSpace(normalizedType) || !normalizedType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
            return "Обложка должна быть изображением.";

        return null;
    }

    public static string? ValidateLicenseId(string? licenseId)
    {
        if (string.IsNullOrWhiteSpace(licenseId) || !AllowedLicenseIds.Contains(licenseId.Trim()))
            return "Выберите лицензию.";
        return null;
    }

    public static string NormalizeContentType(string? contentType)
    {
        if (string.IsNullOrWhiteSpace(contentType))
            return string.Empty;
        return contentType.Split(';')[0].Trim();
    }

    public static string NormalizeTitle(string? title) =>
        string.IsNullOrWhiteSpace(title) ? "Без названия" : title.Trim();

    public static string NormalizeArtist(string? artist) =>
        string.IsNullOrWhiteSpace(artist) ? string.Empty : artist.Trim();
}

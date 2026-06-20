namespace Flora.Shared;

/// <summary>Латинские идентификаторы: никнеймы и slug сообществ (без кириллицы и прочих алфавитов).</summary>
public static class LatinIdentifiers
{
    public const string UsernameFormatMessage =
        "Никнейм: только латиница, цифры и подчёркивание.";

    public const string SlugFormatMessage =
        "Ссылка: только латиница, цифры, дефис и подчёркивание.";

    public static bool IsAllowedUsernameChar(char c) =>
        c is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '_';

    public static bool IsAllowedSlugChar(char c) =>
        IsAllowedUsernameChar(c) || c == '-';

    public static string NormalizeUsername(string? raw, int maxLen = 50)
    {
        if (string.IsNullOrWhiteSpace(raw))
            return "";
        var s = raw.Trim();
        if (s.StartsWith('@'))
            s = s[1..];
        s = new string(s.Where(IsAllowedUsernameChar).ToArray());
        return s.Length > maxLen ? s[..maxLen] : s;
    }

    public static string NormalizeSlug(string? raw, int maxLen = 100)
    {
        if (string.IsNullOrWhiteSpace(raw))
            return "";
        var s = raw.Trim().ToLowerInvariant();
        s = new string(s.Where(IsAllowedSlugChar).ToArray());
        return s.Length > maxLen ? s[..maxLen] : s;
    }

    public static bool HasOnlyUsernameChars(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
            return false;
        var s = raw.Trim();
        if (s.StartsWith('@'))
            s = s[1..];
        return s.Length > 0 && s.All(IsAllowedUsernameChar);
    }

    public static bool HasOnlySlugChars(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
            return false;
        return raw.Trim().All(IsAllowedSlugChar);
    }
}

using System.Text.RegularExpressions;

namespace Flora.Music.Application.Artists;

public static partial class MusicArtistNameNormalizer
{
    public static string Normalize(string? displayName)
    {
        if (string.IsNullOrWhiteSpace(displayName))
            return string.Empty;

        var trimmed = displayName.Trim();
        return WhitespaceCollapse().Replace(trimmed.ToLowerInvariant(), " ");
    }

    public static bool IsValidDisplayName(string? displayName) =>
        !string.IsNullOrWhiteSpace(displayName) && displayName.Trim().Length > 0;

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespaceCollapse();
}

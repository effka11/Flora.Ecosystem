namespace Flora.Notifications;

public static class FloraClientHeader
{
    public static string? TryGetPlatform(string? header)
    {
        if (string.IsNullOrWhiteSpace(header)) return null;
        var slash = header.IndexOf('/');
        var platform = (slash >= 0 ? header[..slash] : header).Trim().ToLowerInvariant();
        return platform is "android" or "ios" or "web" ? platform : null;
    }
}

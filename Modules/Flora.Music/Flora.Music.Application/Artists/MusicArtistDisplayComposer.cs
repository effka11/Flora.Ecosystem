using Flora.Music.Domain;

namespace Flora.Music.Application.Artists;

public static class MusicArtistDisplayComposer
{
    public static string Compose(IReadOnlyList<(string DisplayName, TrackArtistJoiner JoinerBefore)> credits)
    {
        if (credits.Count == 0)
            return string.Empty;

        var parts = new List<string>();
        for (var i = 0; i < credits.Count; i++)
        {
            var (name, joiner) = credits[i];
            if (i > 0)
                parts.Add(JoinerText(joiner));
            parts.Add(name);
        }

        return string.Concat(parts);
    }

    private static string JoinerText(TrackArtistJoiner joiner) => joiner switch
    {
        TrackArtistJoiner.And => "  &  ",
        TrackArtistJoiner.Ft => "  ft.  ",
        TrackArtistJoiner.Vs => "  vs.  ",
        TrackArtistJoiner.Prod => "  prod.  ",
        TrackArtistJoiner.Mix => "  mix.  ",
        TrackArtistJoiner.Remix => "  remix  ",
        TrackArtistJoiner.Edit => "  edit.  ",
        TrackArtistJoiner.Pres => "  pres.  ",
        _ => string.Empty,
    };
}

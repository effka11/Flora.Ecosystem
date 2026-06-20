namespace Flora.Music.Application.Artists;

public sealed record ParsedArtistSegment(string Name, BackfillTrackArtistJoiner JoinerBefore);

public static class MusicArtistDisplayParser
{
    private static readonly (string Text, BackfillTrackArtistJoiner Id)[] Joiners =
    [
        ("  &  ", BackfillTrackArtistJoiner.And),
        ("  ft.  ", BackfillTrackArtistJoiner.Ft),
        ("  vs.  ", BackfillTrackArtistJoiner.Vs),
        ("  prod.  ", BackfillTrackArtistJoiner.Prod),
        ("  mix.  ", BackfillTrackArtistJoiner.Mix),
        ("  remix  ", BackfillTrackArtistJoiner.Remix),
        ("  edit.  ", BackfillTrackArtistJoiner.Edit),
        ("  pres.  ", BackfillTrackArtistJoiner.Pres),
        (" feat. ", BackfillTrackArtistJoiner.Ft),
        (" & ", BackfillTrackArtistJoiner.And),
        (" ft. ", BackfillTrackArtistJoiner.Ft),
        (" vs. ", BackfillTrackArtistJoiner.Vs),
        (" prod. ", BackfillTrackArtistJoiner.Prod),
        (" mix. ", BackfillTrackArtistJoiner.Mix),
        (" remix ", BackfillTrackArtistJoiner.Remix),
        (" edit. ", BackfillTrackArtistJoiner.Edit),
        (" pres. ", BackfillTrackArtistJoiner.Pres),
    ];

    public static IReadOnlyList<ParsedArtistSegment> Parse(string? artistDisplay)
    {
        if (string.IsNullOrWhiteSpace(artistDisplay))
            return [];

        var segments = new List<ParsedArtistSegment>();
        var value = artistDisplay;
        var index = 0;
        var isFirst = true;

        while (index <= value.Length)
        {
            (string Text, BackfillTrackArtistJoiner Id)? earliest = null;
            var earliestAt = value.Length;

            foreach (var opt in Joiners)
            {
                var at = value.IndexOf(opt.Text, index, StringComparison.OrdinalIgnoreCase);
                if (at >= 0 && at < earliestAt)
                {
                    earliest = opt;
                    earliestAt = at;
                }
            }

            var chunkEnd = earliest?.Text != null ? earliestAt : value.Length;
            if (chunkEnd > index)
            {
                var name = value[index..chunkEnd].Trim();
                if (MusicArtistNameNormalizer.IsValidDisplayName(name))
                {
                    segments.Add(new ParsedArtistSegment(
                        name,
                        isFirst ? BackfillTrackArtistJoiner.None : BackfillTrackArtistJoiner.Unrecognized));
                    isFirst = false;
                }
            }

            if (earliest == null)
                break;

            if (segments.Count > 0)
            {
                var last = segments[^1];
                segments[^1] = last with { JoinerBefore = earliest.Value.Id };
            }

            index = earliestAt + earliest.Value.Text.Length;
        }

        return segments;
    }
}

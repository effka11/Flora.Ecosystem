using System.Text.Json;
using Flora.Music.Application.Artists;
using Flora.Music.Contracts;
using Flora.Music.Domain;

namespace Flora.Music;

internal static class MusicArtistControllerHelpers
{
    public static IReadOnlyList<TrackArtistCreditInput> ParseArtistCredits(string? artistCreditsJson)
    {
        if (string.IsNullOrWhiteSpace(artistCreditsJson))
            return [];

        try
        {
            var dtos = JsonSerializer.Deserialize<List<TrackArtistCreditInputDto>>(
                artistCreditsJson,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });

            if (dtos == null || dtos.Count == 0)
                return [];

            return dtos.Select(d => new TrackArtistCreditInput(
                d.ArtistUuid,
                MapJoiner(d.JoinerBefore))).ToList();
        }
        catch (JsonException)
        {
            return [];
        }
    }

    public static TrackArtistJoiner MapJoiner(TrackArtistJoinerDto joiner) => joiner switch
    {
        TrackArtistJoinerDto.And => TrackArtistJoiner.And,
        TrackArtistJoinerDto.Ft => TrackArtistJoiner.Ft,
        TrackArtistJoinerDto.Vs => TrackArtistJoiner.Vs,
        TrackArtistJoinerDto.Prod => TrackArtistJoiner.Prod,
        TrackArtistJoinerDto.Mix => TrackArtistJoiner.Mix,
        TrackArtistJoinerDto.Remix => TrackArtistJoiner.Remix,
        TrackArtistJoinerDto.Edit => TrackArtistJoiner.Edit,
        TrackArtistJoinerDto.Pres => TrackArtistJoiner.Pres,
        _ => TrackArtistJoiner.None,
    };

    public static object MapArtistSummary(MusicArtistSummaryDto artist) => new
    {
        artistUuid = artist.ArtistUuid,
        displayName = artist.DisplayName,
        linkedUserUuid = artist.LinkedUserUuid,
        createdByUserUuid = artist.CreatedByUserUuid,
        tracksCount = artist.TracksCount,
        hasCoverImage = artist.HasCoverImage,
    };

    public static object MapArtistDetail(MusicArtistDetailDto artist) => new
    {
        artistUuid = artist.ArtistUuid,
        displayName = artist.DisplayName,
        linkedUserUuid = artist.LinkedUserUuid,
        createdByUserUuid = artist.CreatedByUserUuid,
        tracksCount = artist.TracksCount,
        hasCoverImage = artist.HasCoverImage,
    };
}

using Flora.Music.Domain;

namespace Flora.Music.Application.Artists;

public static class MusicArtistCreditValidator
{
    public static string? ValidateUploadCredits(IReadOnlyList<TrackArtistCreditInput> credits)
    {
        if (credits.Count == 0)
            return "Укажите хотя бы одного исполнителя.";

        for (var i = 0; i < credits.Count; i++)
        {
            var credit = credits[i];
            if (i == 0)
            {
                if (credit.JoinerBefore != TrackArtistJoiner.None)
                    return "У первого исполнителя не должно быть разделителя.";
            }
            else if (credit.JoinerBefore == TrackArtistJoiner.None)
            {
                return "Укажите способ добавления для каждого исполнителя после первого.";
            }
        }

        return null;
    }
}

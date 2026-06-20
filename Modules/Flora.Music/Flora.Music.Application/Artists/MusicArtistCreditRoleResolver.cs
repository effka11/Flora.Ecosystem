using Flora.Music.Domain;

namespace Flora.Music.Application.Artists;

public static class MusicArtistCreditRoleResolver
{
    public static TrackArtistRole Resolve(TrackArtistJoiner joinerBefore, int index) =>
        index == 0 ? TrackArtistRole.Primary : ResolveFromJoiner(joinerBefore);

    public static TrackArtistRole ResolveFromJoiner(TrackArtistJoiner joinerBefore) => joinerBefore switch
    {
        TrackArtistJoiner.Ft => TrackArtistRole.Featured,
        TrackArtistJoiner.And => TrackArtistRole.Primary,
        TrackArtistJoiner.Prod => TrackArtistRole.Producer,
        TrackArtistJoiner.Remix => TrackArtistRole.Remixer,
        TrackArtistJoiner.Vs or TrackArtistJoiner.Mix or TrackArtistJoiner.Edit or TrackArtistJoiner.Pres =>
            TrackArtistRole.Other,
        _ => TrackArtistRole.Primary,
    };

    public static TrackArtistJoiner MapBackfillJoiner(BackfillTrackArtistJoiner joiner) => joiner switch
    {
        BackfillTrackArtistJoiner.And => TrackArtistJoiner.And,
        BackfillTrackArtistJoiner.Ft => TrackArtistJoiner.Ft,
        BackfillTrackArtistJoiner.Vs => TrackArtistJoiner.Vs,
        BackfillTrackArtistJoiner.Prod => TrackArtistJoiner.Prod,
        BackfillTrackArtistJoiner.Mix => TrackArtistJoiner.Mix,
        BackfillTrackArtistJoiner.Remix => TrackArtistJoiner.Remix,
        BackfillTrackArtistJoiner.Edit => TrackArtistJoiner.Edit,
        BackfillTrackArtistJoiner.Pres => TrackArtistJoiner.Pres,
        _ => TrackArtistJoiner.None,
    };
}

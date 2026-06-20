import type { MusicTrackDto } from "@/lib/musicApi";
import { coverColorIdToColor } from "@/app/(dashboard)/music/musicDefaultCovers";
import { parseMusicTrackKindId } from "@/app/(dashboard)/music/musicTrackKinds";
import type { MusicTrackItem } from "@/app/(dashboard)/music/musicTracks";

export function mapMusicTrackDtoToItem(track: MusicTrackDto): MusicTrackItem {
  const isPlatform = track.scope === "platform";
  return {
    id: track.trackUuid,
    source: isPlatform ? "platform" : "uploaded",
    title: track.title,
    artist: track.artistDisplay,
    artistCredits: track.artistCredits,
    durationSeconds: Math.max(0, Math.round(track.durationMs / 1000)),
    coverColor: coverColorIdToColor(track.coverColorId),
    trackKindId: parseMusicTrackKindId(track.trackKindId),
    hasCoverImage: track.hasCoverImage,
    isOwnPlatformUpload: isPlatform,
  };
}

import type {
  MusicFlowTrackDto,
  MusicPlaylistDetailDto,
  MusicPlaylistSummaryDto,
  MusicTrackDto,
  TrackArtistCredit,
} from "@flora/client-core/contracts";
import { coverColorIdToColor, MUSIC_DEFAULT_COVER_ID, parseMusicTrackKindId } from "@/lib/music/musicCatalog";

export type MusicTrackItem = {
  id: string;
  title: string;
  artist: string;
  artistCredits: TrackArtistCredit[];
  durationMs: number;
  coverColor: string;
  coverColorId: string;
  trackKindId: string;
  hasCoverImage: boolean;
  scope?: "personal" | "platform";
};

export type PlaylistItem = {
  id: string;
  title: string;
  trackCount: number;
  kind: "system" | "user";
  variant: string;
  canDelete: boolean;
  coverColor: string;
  tracks?: MusicTrackItem[];
};

export function formatMusicDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function mapMusicTrackDto(track: MusicTrackDto | MusicFlowTrackDto): MusicTrackItem {
  const coverColorId = track.coverColorId || MUSIC_DEFAULT_COVER_ID;
  return {
    id: track.trackUuid,
    title: track.title || "Трек",
    artist: track.artistDisplay || "Неизвестный исполнитель",
    artistCredits: track.artistCredits ?? [],
    durationMs: track.durationMs,
    coverColor: coverColorIdToColor(coverColorId),
    coverColorId,
    trackKindId: parseMusicTrackKindId(track.trackKindId),
    hasCoverImage: track.hasCoverImage,
    scope: "scope" in track ? track.scope : undefined,
  };
}

export function mapMusicTracksDto(tracks: readonly (MusicTrackDto | MusicFlowTrackDto)[]): MusicTrackItem[] {
  return tracks.map(mapMusicTrackDto);
}

export function mapPlaylistSummaryDto(playlist: MusicPlaylistSummaryDto): PlaylistItem {
  const coverColorId = playlist.coverColorId || MUSIC_DEFAULT_COVER_ID;
  return {
    id: playlist.id,
    title: playlist.title || "Плейлист",
    trackCount: playlist.trackCount,
    kind: playlist.kind,
    variant: playlist.variant,
    canDelete: playlist.canDelete,
    coverColor: coverColorIdToColor(coverColorId),
  };
}

export function mapPlaylistDetailDto(playlist: MusicPlaylistDetailDto): PlaylistItem {
  return {
    ...mapPlaylistSummaryDto(playlist),
    tracks: mapMusicTracksDto(playlist.tracks),
  };
}

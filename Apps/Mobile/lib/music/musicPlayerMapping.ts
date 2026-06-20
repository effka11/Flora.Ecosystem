import type { MusicFlowTrackDto, MusicTrackDto } from "@flora/client-core/contracts";
import type { PlayerTrack } from "@/stores/musicStore";
import { mapMusicTrackDto, type MusicTrackItem } from "@/lib/music/musicModels";

export function musicTrackItemToPlayerTrack(track: MusicTrackItem): PlayerTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    durationMs: track.durationMs,
    coverColor: track.coverColor,
    hasCoverImage: track.hasCoverImage,
  };
}

export function musicTrackDtoToPlayerTrack(track: MusicTrackDto | MusicFlowTrackDto): PlayerTrack {
  return musicTrackItemToPlayerTrack(mapMusicTrackDto(track));
}

export function musicTrackItemsToPlayerTracks(tracks: readonly MusicTrackItem[]): PlayerTrack[] {
  return tracks.map(musicTrackItemToPlayerTrack);
}

export function musicTrackDtosToPlayerTracks(tracks: readonly (MusicTrackDto | MusicFlowTrackDto)[]): PlayerTrack[] {
  return tracks.map(musicTrackDtoToPlayerTrack);
}

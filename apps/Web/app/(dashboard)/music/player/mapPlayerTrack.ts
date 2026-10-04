import { coverColorIdToColor } from "@/app/(dashboard)/music/musicDefaultCovers";
import { parseMusicTrackKindId } from "@/app/(dashboard)/music/musicTrackKinds";
import type { MusicTrackItem } from "@/app/(dashboard)/music/musicTracks";
import type { PlayerTrack } from "@/app/(dashboard)/music/player/playerTypes";
import {
  apiFetchMusicTrackAudioBlob,
  type MusicFlowTrackDto,
} from "@/lib/musicApi";
import { getMusicTrackCoverBlobCached } from "@/lib/musicTrackCoverCache";

export function mapMusicTrackItemToPlayerTrack(track: MusicTrackItem): PlayerTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist,
    artistCredits: track.artistCredits,
    durationSeconds: track.durationSeconds,
    coverColor: track.coverColor,
    trackKindId: track.trackKindId,
    loadAudio: () => apiFetchMusicTrackAudioBlob(track.id),
    loadCover: track.hasCoverImage ? () => getMusicTrackCoverBlobCached(track.id) : undefined,
  };
}

export function mapMusicTrackItemsToPlayerTracks(tracks: MusicTrackItem[]): PlayerTrack[] {
  return tracks.map(mapMusicTrackItemToPlayerTrack);
}

export function mapFlowTrackDtoToPlayerTrack(track: MusicFlowTrackDto): PlayerTrack {
  return {
    id: track.trackUuid,
    title: track.title,
    artist: track.artistDisplay,
    artistCredits: track.artistCredits,
    durationSeconds: Math.max(0, Math.round(track.durationMs / 1000)),
    coverColor: coverColorIdToColor(track.coverColorId),
    trackKindId: parseMusicTrackKindId(track.trackKindId),
    loadAudio: () => apiFetchMusicTrackAudioBlob(track.trackUuid),
    loadCover: track.hasCoverImage ? () => getMusicTrackCoverBlobCached(track.trackUuid) : undefined,
  };
}

export function mapFlowTrackDtosToPlayerTracks(tracks: MusicFlowTrackDto[]): PlayerTrack[] {
  return tracks.map(mapFlowTrackDtoToPlayerTrack);
}

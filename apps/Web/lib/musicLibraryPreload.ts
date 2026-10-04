import { mapPlaylistSummaryDto, type PlaylistItem } from "@/app/(dashboard)/music/musicPlaylists";
import { mapMusicTrackDtoToItem } from "@/app/(dashboard)/music/musicTrackMappers";
import type { MusicTrackItem } from "@/app/(dashboard)/music/musicTracks";
import { invalidateMusicCaches, musicLibraryCache, musicPlaylistsCache } from "@/lib/dashboardPreload";

export type MusicLibrarySnapshot = {
  tracks: MusicTrackItem[];
  playlists: PlaylistItem[];
};

export function peekMusicLibrarySnapshot(): MusicLibrarySnapshot | null {
  const library = musicLibraryCache.peek();
  const playlists = musicPlaylistsCache.peek();
  if (!library || !playlists) return null;
  return {
    tracks: library.map(mapMusicTrackDtoToItem),
    playlists: playlists.map(mapPlaylistSummaryDto),
  };
}

export async function loadMusicLibrarySnapshot(options?: { refresh?: boolean }): Promise<MusicLibrarySnapshot> {
  if (options?.refresh) {
    invalidateMusicCaches();
  }

  const [library, playlistRows] = await Promise.all([musicLibraryCache.get(), musicPlaylistsCache.get()]);
  musicLibraryCache.set(library);
  musicPlaylistsCache.set(playlistRows);

  return {
    tracks: library.map(mapMusicTrackDtoToItem),
    playlists: playlistRows.map(mapPlaylistSummaryDto),
  };
}

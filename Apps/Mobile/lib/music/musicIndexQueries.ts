import { apiGetMusicLibrary, apiGetMusicPlaylists } from "@flora/client-core/api";
import { mapMusicTracksDto, mapPlaylistSummaryDto } from "@/lib/music/musicModels";

/** Root Music tab cache keys — not nested playlist/genre/artist routes. */
export const MUSIC_LIBRARY_QUERY_KEY = ["music-library"] as const;
export const MUSIC_PLAYLISTS_QUERY_KEY = ["music-playlists"] as const;

export async function fetchMusicLibraryQuery() {
  return mapMusicTracksDto(await apiGetMusicLibrary());
}

export async function fetchMusicPlaylistsQuery() {
  return (await apiGetMusicPlaylists()).map(mapPlaylistSummaryDto);
}

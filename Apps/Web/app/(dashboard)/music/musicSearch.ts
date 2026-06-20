import type { MusicGenreItem } from "@/app/(dashboard)/music/musicGenres";
import type { PlaylistItem } from "@/app/(dashboard)/music/musicPlaylists";
import type { MusicTrackItem } from "@/app/(dashboard)/music/musicTracks";

export function normalizeMusicSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function matchesMusicSearch(query: string, ...parts: Array<string | undefined | null>): boolean {
  if (!query) return true;
  return parts.some((part) => part?.toLowerCase().includes(query));
}

export function filterMusicTracks(tracks: readonly MusicTrackItem[], query: string): MusicTrackItem[] {
  const q = normalizeMusicSearchQuery(query);
  if (!q) return [...tracks];
  return tracks.filter((track) => matchesMusicSearch(q, track.title, track.artist));
}

export function filterMusicPlaylists(playlists: readonly PlaylistItem[], query: string): PlaylistItem[] {
  const q = normalizeMusicSearchQuery(query);
  if (!q) return [...playlists];
  return playlists.filter((playlist) => matchesMusicSearch(q, playlist.title));
}

export function filterMusicGenres(genres: readonly MusicGenreItem[], query: string): MusicGenreItem[] {
  const q = normalizeMusicSearchQuery(query);
  if (!q) return [...genres];
  return genres.filter((genre) => matchesMusicSearch(q, genre.title, genre.id));
}

/** Catalog search is server-side (`apiSearchMusicTracks`). Keep query trim in one place. */
export function normalizeMusicSearchQuery(query: string): string {
  return query.trim().toLowerCase();
}

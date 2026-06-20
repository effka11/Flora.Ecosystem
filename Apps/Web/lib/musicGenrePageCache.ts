import { apiGetMusicGenrePage, type MusicGenrePageDto } from "@/lib/musicApi";
import { prefetchMusicTrackCoversFromPage } from "@/lib/musicTrackCoverCache";

const TTL_MS = 60_000;

type CacheEntry = {
  value: MusicGenrePageDto;
  fetchedAt: number;
};

const entries = new Map<string, CacheEntry>();
const inFlights = new Map<string, Promise<MusicGenrePageDto>>();

export function musicGenrePageCacheKey(genreId: string, subgenreId?: string): string {
  const genre = genreId.trim().toLowerCase();
  const subgenre = subgenreId?.trim().toLowerCase();
  return subgenre ? `${genre}:${subgenre}` : `${genre}:all`;
}

function isFresh(entry: CacheEntry): boolean {
  return Date.now() - entry.fetchedAt < TTL_MS;
}

export function peekMusicGenrePage(genreId: string, subgenreId?: string): MusicGenrePageDto | null {
  const key = musicGenrePageCacheKey(genreId, subgenreId);
  const entry = entries.get(key);
  if (!entry || !isFresh(entry)) return null;
  return entry.value;
}

export function prefetchMusicGenrePage(genreId: string, subgenreId?: string): void {
  const key = musicGenrePageCacheKey(genreId, subgenreId);
  const entry = entries.get(key);
  if (entry && isFresh(entry)) return;
  if (inFlights.has(key)) return;

  const task = apiGetMusicGenrePage(genreId, subgenreId)
    .then((value) => {
      entries.set(key, { value, fetchedAt: Date.now() });
      prefetchMusicTrackCoversFromPage(value);
      return value;
    })
    .finally(() => {
      inFlights.delete(key);
    });

  inFlights.set(key, task);
  void task.catch(() => {});
}

export async function getMusicGenrePageCached(
  genreId: string,
  subgenreId?: string,
): Promise<MusicGenrePageDto> {
  const key = musicGenrePageCacheKey(genreId, subgenreId);
  const entry = entries.get(key);
  if (entry && isFresh(entry)) return entry.value;

  const pending = inFlights.get(key);
  if (pending) return pending;

  const task = apiGetMusicGenrePage(genreId, subgenreId)
    .then((value) => {
      entries.set(key, { value, fetchedAt: Date.now() });
      prefetchMusicTrackCoversFromPage(value);
      return value;
    })
    .finally(() => {
      inFlights.delete(key);
    });

  inFlights.set(key, task);
  return task;
}

export function seedMusicGenrePageCache(
  genreId: string,
  subgenreId: string | undefined,
  page: MusicGenrePageDto,
): void {
  const key = musicGenrePageCacheKey(genreId, subgenreId);
  entries.set(key, { value: page, fetchedAt: Date.now() });
  prefetchMusicTrackCoversFromPage(page);
}

export function prefetchMusicGenreSubgenres(
  genreId: string,
  subgenreIds: readonly string[],
  options?: { skipSubgenreId?: string },
): void {
  prefetchMusicGenrePage(genreId);

  const skip = options?.skipSubgenreId?.trim().toLowerCase();
  for (const subgenreId of subgenreIds) {
    if (subgenreId.trim().toLowerCase() === skip) continue;
    prefetchMusicGenrePage(genreId, subgenreId);
  }
}

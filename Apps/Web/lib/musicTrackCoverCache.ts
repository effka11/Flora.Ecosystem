import { apiFetchMusicTrackCoverBlob, type MusicGenrePageDto } from "@/lib/musicApi";

const TTL_MS = 300_000;

type CachedCover = {
  blob: Blob;
  objectUrl: string;
  fetchedAt: number;
};

const cache = new Map<string, CachedCover>();
const inflight = new Map<string, Promise<string>>();

function normalizeTrackId(trackUuid: string): string | null {
  if (typeof trackUuid !== "string") return null;
  const id = trackUuid.trim().toLowerCase();
  return id || null;
}

function isFresh(entry: CachedCover): boolean {
  return Date.now() - entry.fetchedAt < TTL_MS;
}

function storeBlob(trackUuid: string, blob: Blob): string {
  const id = normalizeTrackId(trackUuid);
  if (!id) throw new Error("Invalid track id.");
  const existing = cache.get(id);
  if (existing && isFresh(existing)) return existing.objectUrl;
  if (existing) URL.revokeObjectURL(existing.objectUrl);
  const objectUrl = URL.createObjectURL(blob);
  cache.set(id, { blob, objectUrl, fetchedAt: Date.now() });
  return objectUrl;
}

export function peekMusicTrackCoverObjectUrl(trackUuid: string): string | null {
  const id = normalizeTrackId(trackUuid);
  if (!id) return null;
  const entry = cache.get(id);
  if (!entry || !isFresh(entry)) return null;
  return entry.objectUrl;
}

export function peekMusicTrackCoverBlob(trackUuid: string): Blob | null {
  const id = normalizeTrackId(trackUuid);
  if (!id) return null;
  const entry = cache.get(id);
  if (!entry || !isFresh(entry)) return null;
  return entry.blob;
}

export function prefetchMusicTrackCover(trackUuid: string): void {
  const id = normalizeTrackId(trackUuid);
  if (!id || peekMusicTrackCoverObjectUrl(trackUuid) || inflight.has(id)) return;
  void ensureMusicTrackCoverObjectUrl(trackUuid).catch(() => {});
}

export async function ensureMusicTrackCoverObjectUrl(trackUuid: string): Promise<string> {
  const cached = peekMusicTrackCoverObjectUrl(trackUuid);
  if (cached) return cached;

  const id = normalizeTrackId(trackUuid);
  if (!id) throw new Error("Invalid track id.");
  const pending = inflight.get(id);
  if (pending) return pending;

  const task = apiFetchMusicTrackCoverBlob(trackUuid)
    .then((blob) => storeBlob(trackUuid, blob))
    .finally(() => {
      inflight.delete(id);
    });

  inflight.set(id, task);
  return task;
}

export async function getMusicTrackCoverBlobCached(trackUuid: string): Promise<Blob> {
  const cached = peekMusicTrackCoverBlob(trackUuid);
  if (cached) return cached;
  await ensureMusicTrackCoverObjectUrl(trackUuid);
  const blob = peekMusicTrackCoverBlob(trackUuid);
  if (!blob) throw new Error("Cover cache miss after fetch.");
  return blob;
}

export function prefetchMusicTrackCovers(trackUuids: readonly (string | undefined | null)[]): void {
  const unique = [
    ...new Set(
      trackUuids
        .map((trackUuid) => normalizeTrackId(trackUuid ?? ""))
        .filter((trackUuid): trackUuid is string => trackUuid != null),
    ),
  ];
  for (const trackUuid of unique) {
    prefetchMusicTrackCover(trackUuid);
  }
}

export function prefetchMusicTrackCoversFromPage(page: MusicGenrePageDto): void {
  const ids: string[] = [];
  for (const collection of page.collections) {
    for (const track of collection.tracks) {
      if (track.hasCoverImage) ids.push(track.trackUuid);
    }
  }
  prefetchMusicTrackCovers(ids);
}

export function prefetchMusicTrackCoversFromCollections(
  collections: readonly { tracks: readonly { id: string; hasCoverImage?: boolean }[] }[],
): void {
  const ids: string[] = [];
  for (const collection of collections) {
    for (const track of collection.tracks) {
      if (track.hasCoverImage) ids.push(track.id);
    }
  }
  prefetchMusicTrackCovers(ids);
}

export function invalidateMusicTrackCover(trackUuid: string): void {
  const id = normalizeTrackId(trackUuid);
  if (!id) return;
  const entry = cache.get(id);
  if (entry) URL.revokeObjectURL(entry.objectUrl);
  cache.delete(id);
  inflight.delete(id);
}

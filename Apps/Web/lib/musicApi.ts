import {
  ApiRequestError,
  clearSession,
  getAccessToken,
  refreshSessionIfPossible,
  resolvePublicApiRoot,
} from "@/lib/auth";

type ApiError = { error?: string; detail?: string; Detail?: string };

export type MusicTrackScope = "personal" | "platform";

export type MusicTrackDto = {
  trackUuid: string;
  scope: MusicTrackScope;
  title: string;
  artistDisplay: string;
  artistCredits: TrackArtistCredit[];
  tags: string | null;
  genreId: string | null;
  licenseId: string | null;
  coverColorId: string | null;
  trackKindId: string | null;
  hasCoverImage: boolean;
  durationMs: number;
  createdAt: string;
  publishedAt: string | null;
};

export type MusicFlowTrackDto = Omit<MusicTrackDto, "scope" | "tags" | "publishedAt"> & {
  publishedAt: string;
  isOwnedByCurrentUser: boolean;
};

export type MusicFlowWaveDto = {
  tracks: MusicFlowTrackDto[];
  generatedAt: string;
  expiresAt: string;
};

export type MusicSubgenreDto = {
  id: string;
  title: string;
  description: string | null;
  trackCount: number;
};

export type MusicGenreDto = {
  id: string;
  title: string;
  description: string | null;
  trackCount: number;
  subgenres: MusicSubgenreDto[];
};

export type MusicGenreCollectionDto = {
  id: string;
  title: string;
  tracks: MusicTrackDto[];
};

export type MusicGenrePageDto = {
  genre: MusicGenreDto;
  activeSubgenre: MusicSubgenreDto | null;
  collections: MusicGenreCollectionDto[];
};

export type TrackArtistJoiner = "None" | "And" | "Ft" | "Vs" | "Prod" | "Mix" | "Remix" | "Edit" | "Pres";

export type MusicArtistSummaryDto = {
  artistUuid: string;
  displayName: string;
  linkedUserUuid: string | null;
  createdByUserUuid: string;
  tracksCount: number;
  hasCoverImage: boolean;
};

export type MusicArtistDetailDto = MusicArtistSummaryDto;

export type TrackArtistCreditInput = {
  artistUuid: string;
  joinerBefore: TrackArtistJoiner;
};

export type TrackArtistCredit = {
  artistUuid: string;
  displayName: string;
  joinerBefore: TrackArtistJoiner;
};

export type PagedMusicTracksDto = {
  tracks: MusicTrackDto[];
  totalCount: number;
  page: number;
  pageSize: number;
};

function apiRoot(): string {
  return resolvePublicApiRoot();
}

function apiUrl(path: string): string {
  const root = apiRoot();
  return root ? `${root}${path}` : path;
}

async function parseErr(r: Response): Promise<string> {
  const data = (await r.json().catch(() => ({}))) as ApiError;
  const base = typeof data.error === "string" ? data.error : `Ошибка ${r.status}`;
  const detailRaw = data.detail ?? data.Detail;
  const detail = typeof detailRaw === "string" && detailRaw.trim().length > 0 ? detailRaw.trim() : "";
  if (detail.length === 0) return base;
  if (base.includes(detail)) return base;
  return `${base} (${detail})`;
}

async function authPostForm(url: string, body: FormData): Promise<unknown> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const init = (t: string): RequestInit => ({
    method: "POST",
    headers: { Authorization: `Bearer ${t}` },
    body,
  });
  let r = await fetch(url, init(token));
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, init(token));
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
  return r.json().catch(() => ({}));
}

async function authGetJson(url: string): Promise<unknown> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const headers = (t: string) => ({ Authorization: `Bearer ${t}` });
  let r = await fetch(url, { headers: headers(token) });
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, { headers: headers(token) });
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
  return r.json().catch(() => ({}));
}

async function authDelete(url: string): Promise<void> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const init = (t: string): RequestInit => ({
    method: "DELETE",
    headers: { Authorization: `Bearer ${t}` },
  });
  let r = await fetch(url, init(token));
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, init(token));
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
}

function readStr(o: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string") return v;
  }
  return "";
}

function readNum(o: Record<string, unknown>, keys: string[]): number {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

function readBool(o: Record<string, unknown>, keys: string[]): boolean {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "boolean") return v;
  }
  return false;
}

function readArray(o: Record<string, unknown>, keys: string[]): unknown[] {
  for (const k of keys) {
    const v = o[k];
    if (Array.isArray(v)) return v;
  }
  return [];
}

function parseScope(raw: string): MusicTrackScope {
  return raw === "platform" ? "platform" : "personal";
}

function parseTrackArtistJoiner(raw: string): TrackArtistJoiner {
  switch (raw) {
    case "And":
      return "And";
    case "Ft":
      return "Ft";
    case "Vs":
      return "Vs";
    case "Prod":
      return "Prod";
    case "Mix":
      return "Mix";
    case "Remix":
      return "Remix";
    case "Edit":
      return "Edit";
    case "Pres":
      return "Pres";
    default:
      return "None";
  }
}

function parseTrackArtistCredit(raw: unknown): TrackArtistCredit | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const artistUuid = readStr(o, ["artistUuid", "ArtistUuid"]);
  if (!artistUuid) return null;
  return {
    artistUuid,
    displayName: readStr(o, ["displayName", "DisplayName"]),
    joinerBefore: parseTrackArtistJoiner(readStr(o, ["joinerBefore", "JoinerBefore"])),
  };
}

function parseTrackArtistCredits(raw: unknown): TrackArtistCredit[] {
  if (!Array.isArray(raw)) return [];
  const out: TrackArtistCredit[] = [];
  for (const item of raw) {
    const parsed = parseTrackArtistCredit(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseMusicTrack(raw: unknown): MusicTrackDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const trackUuid = readStr(o, ["trackUuid", "TrackUuid"]);
  if (!trackUuid) return null;
  return {
    trackUuid,
    scope: parseScope(readStr(o, ["scope", "Scope"])),
    title: readStr(o, ["title", "Title"]),
    artistDisplay: readStr(o, ["artistDisplay", "ArtistDisplay"]),
    artistCredits: parseTrackArtistCredits(o.artistCredits ?? o.ArtistCredits),
    tags: readStr(o, ["tags", "Tags"]) || null,
    genreId: readStr(o, ["genreId", "GenreId"]) || null,
    licenseId: readStr(o, ["licenseId", "LicenseId"]) || null,
    coverColorId: readStr(o, ["coverColorId", "CoverColorId"]) || null,
    trackKindId: readStr(o, ["trackKindId", "TrackKindId"]) || null,
    hasCoverImage: readBool(o, ["hasCoverImage", "HasCoverImage"]),
    durationMs: readNum(o, ["durationMs", "DurationMs"]),
    createdAt: readStr(o, ["createdAt", "CreatedAt"]),
    publishedAt: readStr(o, ["publishedAt", "PublishedAt"]) || null,
  };
}

function parseMusicFlowTrack(raw: unknown): MusicFlowTrackDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const trackUuid = readStr(o, ["trackUuid", "TrackUuid"]);
  if (!trackUuid) return null;
  return {
    trackUuid,
    title: readStr(o, ["title", "Title"]),
    artistDisplay: readStr(o, ["artistDisplay", "ArtistDisplay"]),
    artistCredits: parseTrackArtistCredits(o.artistCredits ?? o.ArtistCredits),
    genreId: readStr(o, ["genreId", "GenreId"]) || null,
    licenseId: readStr(o, ["licenseId", "LicenseId"]) || null,
    coverColorId: readStr(o, ["coverColorId", "CoverColorId"]) || null,
    trackKindId: readStr(o, ["trackKindId", "TrackKindId"]) || null,
    hasCoverImage: readBool(o, ["hasCoverImage", "HasCoverImage"]),
    durationMs: readNum(o, ["durationMs", "DurationMs"]),
    createdAt: readStr(o, ["createdAt", "CreatedAt"]),
    publishedAt: readStr(o, ["publishedAt", "PublishedAt"]),
    isOwnedByCurrentUser: readBool(o, ["isOwnedByCurrentUser", "IsOwnedByCurrentUser"]),
  };
}

function parseMusicSubgenre(raw: unknown): MusicSubgenreDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = readStr(o, ["id", "Id", "subgenreId", "SubgenreId"]);
  if (!id) return null;
  return {
    id,
    title: readStr(o, ["title", "Title", "name", "Name"]),
    description: readStr(o, ["description", "Description"]) || null,
    trackCount: readNum(o, ["trackCount", "TrackCount"]),
  };
}

function parseMusicGenre(raw: unknown): MusicGenreDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = readStr(o, ["id", "Id", "genreId", "GenreId"]);
  if (!id) return null;
  const subgenres: MusicSubgenreDto[] = [];
  for (const item of readArray(o, ["subgenres", "Subgenres"])) {
    const parsed = parseMusicSubgenre(item);
    if (parsed) subgenres.push(parsed);
  }
  return {
    id,
    title: readStr(o, ["title", "Title", "name", "Name"]),
    description: readStr(o, ["description", "Description"]) || null,
    trackCount: readNum(o, ["trackCount", "TrackCount"]),
    subgenres,
  };
}

function parseMusicGenreCollection(raw: unknown): MusicGenreCollectionDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = readStr(o, ["id", "Id", "collectionId", "CollectionId"]);
  if (!id) return null;
  const tracks: MusicTrackDto[] = [];
  for (const item of readArray(o, ["tracks", "Tracks"])) {
    const parsed = parseMusicTrack(item);
    if (parsed) tracks.push(parsed);
  }
  return {
    id,
    title: readStr(o, ["title", "Title"]),
    tracks,
  };
}

function buildMusicGenreCollection(id: string, title: string, rows: unknown[]): MusicGenreCollectionDto {
  const tracks: MusicTrackDto[] = [];
  for (const item of rows) {
    const parsed = parseMusicTrack(item);
    if (parsed) tracks.push(parsed);
  }
  return { id, title, tracks };
}

function parseMusicGenrePage(raw: unknown): MusicGenrePageDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const genre = parseMusicGenre(o.genre ?? o.Genre ?? raw);
  if (!genre) return null;
  const activeSubgenre = parseMusicSubgenre(o.activeSubgenre ?? o.ActiveSubgenre);
  const collections: MusicGenreCollectionDto[] = [];

  for (const item of readArray(o, ["collections", "Collections"])) {
    const parsed = parseMusicGenreCollection(item);
    if (parsed) collections.push(parsed);
  }

  if (collections.length === 0) {
    const plannedCollections = [
      ["popular", "Популярное", readArray(o, ["popularTracks", "PopularTracks"])],
      ["new", "Новое", readArray(o, ["newTracks", "NewTracks"])],
    ] as const;

    for (const [id, title, rows] of plannedCollections) {
      collections.push(buildMusicGenreCollection(id, title, rows));
    }
  }

  return {
    genre,
    activeSubgenre,
    collections,
  };
}

function parseMusicArtist(raw: unknown): MusicArtistSummaryDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const artistUuid = readStr(o, ["artistUuid", "ArtistUuid"]);
  if (!artistUuid) return null;
  return {
    artistUuid,
    displayName: readStr(o, ["displayName", "DisplayName"]),
    linkedUserUuid: readStr(o, ["linkedUserUuid", "LinkedUserUuid"]) || null,
    createdByUserUuid: readStr(o, ["createdByUserUuid", "CreatedByUserUuid"]),
    tracksCount: readNum(o, ["tracksCount", "TracksCount"]),
    hasCoverImage: readBool(o, ["hasCoverImage", "HasCoverImage"]),
  };
}

function parsePagedMusicTracks(raw: unknown, fallbackPage: number, fallbackPageSize: number): PagedMusicTracksDto {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const rows = Array.isArray(raw) ? raw : readArray(o, ["tracks", "Tracks"]);
  const tracks: MusicTrackDto[] = [];
  for (const item of rows) {
    const parsed = parseMusicTrack(item);
    if (parsed) tracks.push(parsed);
  }

  return {
    tracks,
    totalCount: readNum(o, ["totalCount", "TotalCount"]) || tracks.length,
    page: readNum(o, ["page", "Page"]) || fallbackPage,
    pageSize: readNum(o, ["pageSize", "PageSize"]) || fallbackPageSize,
  };
}

export function musicTrackAudioUrl(trackUuid: string): string {
  return apiUrl(`/api/music/tracks/${encodeURIComponent(trackUuid)}/audio`);
}

export function musicTrackCoverUrl(trackUuid: string): string {
  return apiUrl(`/api/music/tracks/${encodeURIComponent(trackUuid)}/cover`);
}

export function musicArtistCoverUrl(artistUuid: string): string {
  return apiUrl(`/api/music/artists/${encodeURIComponent(artistUuid)}/cover`);
}

export async function apiGetMusicLibrary(): Promise<MusicTrackDto[]> {
  const raw = await authGetJson(apiUrl("/api/music/tracks/library"));
  if (!Array.isArray(raw)) return [];
  const out: MusicTrackDto[] = [];
  for (const item of raw) {
    const parsed = parseMusicTrack(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function apiGetMusicGenreCatalog(): Promise<MusicGenreDto[]> {
  const raw = await authGetJson(apiUrl("/api/music/genres"));
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? readArray(raw as Record<string, unknown>, ["genres", "Genres"])
      : [];
  const out: MusicGenreDto[] = [];
  for (const item of rows) {
    const parsed = parseMusicGenre(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function apiGetMusicGenrePage(
  genreId: string,
  subgenreId?: string,
): Promise<MusicGenrePageDto> {
  const query = new URLSearchParams();
  if (subgenreId) query.set("subgenreId", subgenreId);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const raw = await authGetJson(apiUrl(`/api/music/genres/${encodeURIComponent(genreId)}${suffix}`));
  const parsed = parseMusicGenrePage(raw);
  if (!parsed) throw new ApiRequestError(500, "Некорректный ответ сервера.");
  return parsed;
}

export async function apiGetMusicFlowWave(params: {
  take?: number;
  excludeTrackUuids?: readonly string[];
  genreId?: string;
  subgenreId?: string;
} = {}): Promise<MusicFlowWaveDto> {
  const query = new URLSearchParams();
  query.set("take", String(Math.max(1, Math.round(params.take ?? 20))));
  if (params.genreId) query.set("genreId", params.genreId);
  if (params.subgenreId) query.set("subgenreId", params.subgenreId);
  for (const trackUuid of params.excludeTrackUuids ?? []) {
    query.append("exclude", trackUuid);
  }

  const raw = await authGetJson(apiUrl(`/api/music/flow?${query.toString()}`));
  if (!raw || typeof raw !== "object") return { tracks: [], generatedAt: "", expiresAt: "" };

  const o = raw as Record<string, unknown>;
  const rows = Array.isArray(o.tracks) ? o.tracks : Array.isArray(o.Tracks) ? o.Tracks : [];
  const tracks: MusicFlowTrackDto[] = [];
  for (const item of rows) {
    const parsed = parseMusicFlowTrack(item);
    if (parsed) tracks.push(parsed);
  }

  return {
    tracks,
    generatedAt: readStr(o, ["generatedAt", "GeneratedAt"]),
    expiresAt: readStr(o, ["expiresAt", "ExpiresAt"]),
  };
}

export async function apiGetMusicArtists(take?: number): Promise<MusicArtistSummaryDto[]> {
  const query = new URLSearchParams();
  if (take !== undefined) query.set("take", String(Math.max(1, Math.round(take))));
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const raw = await authGetJson(apiUrl(`/api/music/artists${suffix}`));
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? readArray(raw as Record<string, unknown>, ["artists", "Artists"])
      : [];
  const out: MusicArtistSummaryDto[] = [];
  for (const item of rows) {
    const parsed = parseMusicArtist(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function apiSearchMusicArtists(q: string, limit?: number): Promise<MusicArtistSummaryDto[]> {
  const query = new URLSearchParams();
  query.set("q", q);
  if (limit !== undefined) query.set("limit", String(Math.max(1, Math.round(limit))));
  const raw = await authGetJson(apiUrl(`/api/music/artists/search?${query.toString()}`));
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? readArray(raw as Record<string, unknown>, ["artists", "Artists", "results", "Results"])
      : [];
  const out: MusicArtistSummaryDto[] = [];
  for (const item of rows) {
    const parsed = parseMusicArtist(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function apiCreateMusicArtist(
  displayName: string,
  linkToMyProfile: boolean,
  cover?: File | null,
): Promise<MusicArtistDetailDto> {
  const form = new FormData();
  form.append("displayName", displayName);
  form.append("linkToMyProfile", linkToMyProfile ? "true" : "false");
  if (cover) form.append("cover", cover);
  const raw = await authPostForm(apiUrl("/api/music/artists"), form);
  const parsed = parseMusicArtist(raw);
  if (!parsed) throw new ApiRequestError(500, "Некорректный ответ сервера.");
  return parsed;
}

export async function apiGetMusicArtist(artistUuid: string): Promise<MusicArtistDetailDto> {
  const raw = await authGetJson(apiUrl(`/api/music/artists/${encodeURIComponent(artistUuid)}`));
  const parsed = parseMusicArtist(raw);
  if (!parsed) throw new ApiRequestError(500, "Некорректный ответ сервера.");
  return parsed;
}

export async function apiGetMusicArtistTracks(
  artistUuid: string,
  page = 1,
  pageSize = 30,
): Promise<PagedMusicTracksDto> {
  const resolvedPage = Math.max(1, Math.round(page));
  const resolvedPageSize = Math.max(1, Math.round(pageSize));
  const query = new URLSearchParams();
  query.set("page", String(resolvedPage));
  query.set("pageSize", String(resolvedPageSize));
  const raw = await authGetJson(
    apiUrl(`/api/music/artists/${encodeURIComponent(artistUuid)}/tracks?${query.toString()}`),
  );
  return parsePagedMusicTracks(raw, resolvedPage, resolvedPageSize);
}

export type UploadMusicTrackSelfParams = {
  file: File;
  title: string;
  artist?: string;
  artistCredits?: TrackArtistCreditInput[];
  tags: string;
  coverColorId: string;
  trackKindId: string;
  durationMs: number;
};

export async function apiUploadMusicTrackSelf(params: UploadMusicTrackSelfParams): Promise<string> {
  const form = new FormData();
  form.append("file", params.file);
  form.append("title", params.title);
  if (params.artist) form.append("artist", params.artist);
  if (params.artistCredits && params.artistCredits.length > 0) {
    form.append("artistCredits", JSON.stringify(params.artistCredits));
  }
  form.append("tags", params.tags);
  form.append("coverColorId", params.coverColorId);
  form.append("trackKindId", params.trackKindId);
  form.append("durationMs", String(Math.max(1, Math.round(params.durationMs))));
  const raw = (await authPostForm(apiUrl("/api/music/tracks/self"), form)) as Record<string, unknown>;
  return readStr(raw, ["trackUuid", "TrackUuid"]);
}

export type UploadMusicTrackPlatformParams = {
  file: File;
  title: string;
  artist?: string;
  artistCredits: TrackArtistCreditInput[];
  genreId: string;
  licenseId: string;
  termsAccepted: boolean;
  durationMs: number;
  cover?: File | null;
};

export async function apiUploadMusicTrackPlatform(params: UploadMusicTrackPlatformParams): Promise<string> {
  const form = new FormData();
  form.append("file", params.file);
  form.append("title", params.title);
  if (params.artist) form.append("artist", params.artist);
  form.append("artistCredits", JSON.stringify(params.artistCredits));
  form.append("genreId", params.genreId);
  form.append("licenseId", params.licenseId);
  form.append("termsAccepted", params.termsAccepted ? "true" : "false");
  form.append("durationMs", String(Math.max(1, Math.round(params.durationMs))));
  if (params.cover) form.append("cover", params.cover);
  const raw = (await authPostForm(apiUrl("/api/music/tracks/platform"), form)) as Record<string, unknown>;
  return readStr(raw, ["trackUuid", "TrackUuid"]);
}

export async function apiDeleteMusicTrack(trackUuid: string): Promise<void> {
  await authDelete(apiUrl(`/api/music/tracks/${encodeURIComponent(trackUuid)}`));
}

async function authGetBlob(url: string): Promise<Blob> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const headers = (t: string) => ({ Authorization: `Bearer ${t}` });
  let r = await fetch(url, { headers: headers(token) });
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, { headers: headers(token) });
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
  const contentType = r.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  const blob = await r.blob();
  if (blob.size === 0) {
    throw new ApiRequestError(r.status, "Пустой файл трека.");
  }
  if (blob.type || !contentType) {
    return blob;
  }
  return blob.slice(0, blob.size, contentType);
}

export async function apiFetchMusicTrackAudioBlob(trackUuid: string): Promise<Blob> {
  return authGetBlob(musicTrackAudioUrl(trackUuid));
}

export async function apiFetchMusicTrackCoverBlob(trackUuid: string): Promise<Blob> {
  return authGetBlob(musicTrackCoverUrl(trackUuid));
}

export async function apiFetchMusicArtistCoverBlob(artistUuid: string): Promise<Blob> {
  return authGetBlob(musicArtistCoverUrl(artistUuid));
}

export type MusicPlaylistKind = "system" | "user";

export type MusicPlaylistSummaryDto = {
  id: string;
  title: string;
  trackCount: number;
  kind: MusicPlaylistKind;
  variant: string;
  canDelete: boolean;
  coverColorId: string | null;
};

export type MusicPlaylistDetailDto = MusicPlaylistSummaryDto & {
  tracks: MusicTrackDto[];
};

function parsePlaylistSummary(raw: unknown): MusicPlaylistSummaryDto | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = readStr(o, ["id", "Id"]);
  if (!id) return null;
  const kindRaw = readStr(o, ["kind", "Kind"]);
  return {
    id,
    title: readStr(o, ["title", "Title"]),
    trackCount: readNum(o, ["trackCount", "TrackCount"]),
    kind: kindRaw === "user" ? "user" : "system",
    variant: readStr(o, ["variant", "Variant"]),
    canDelete: readBool(o, ["canDelete", "CanDelete"]),
    coverColorId: readStr(o, ["coverColorId", "CoverColorId"]) || null,
  };
}

function parsePlaylistDetail(raw: unknown): MusicPlaylistDetailDto | null {
  const summary = parsePlaylistSummary(raw);
  if (!summary) return null;
  if (!raw || typeof raw !== "object") return null;
  const tracksRaw = (raw as Record<string, unknown>).tracks ?? (raw as Record<string, unknown>).Tracks;
  const tracks: MusicTrackDto[] = [];
  if (Array.isArray(tracksRaw)) {
    for (const item of tracksRaw) {
      const parsed = parseMusicTrack(item);
      if (parsed) tracks.push(parsed);
    }
  }
  return { ...summary, tracks };
}

async function authPostJson(url: string, body: unknown): Promise<unknown> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const init = (t: string): RequestInit => ({
    method: "POST",
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let r = await fetch(url, init(token));
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, init(token));
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
  return r.json().catch(() => ({}));
}

export async function apiGetMusicPlaylists(): Promise<MusicPlaylistSummaryDto[]> {
  const raw = await authGetJson(apiUrl("/api/music/playlists"));
  if (!Array.isArray(raw)) return [];
  const out: MusicPlaylistSummaryDto[] = [];
  for (const item of raw) {
    const parsed = parsePlaylistSummary(item);
    if (parsed) out.push(parsed);
  }
  return out;
}

export async function apiGetMusicPlaylist(playlistId: string): Promise<MusicPlaylistDetailDto> {
  const raw = await authGetJson(apiUrl(`/api/music/playlists/${encodeURIComponent(playlistId)}`));
  const parsed = parsePlaylistDetail(raw);
  if (!parsed) throw new ApiRequestError(500, "Некорректный ответ сервера.");
  return parsed;
}

export async function apiCreateMusicPlaylist(title: string): Promise<string> {
  const raw = (await authPostJson(apiUrl("/api/music/playlists"), { title })) as Record<string, unknown>;
  return readStr(raw, ["playlistId", "PlaylistId"]);
}

export async function apiDeleteMusicPlaylist(playlistId: string): Promise<void> {
  await authDelete(apiUrl(`/api/music/playlists/${encodeURIComponent(playlistId)}`));
}

export async function apiAddMusicTrackFavorite(trackUuid: string): Promise<void> {
  let token = getAccessToken();
  if (!token) throw new ApiRequestError(401, "Сессия истекла. Войдите снова.");
  const url = apiUrl(`/api/music/tracks/${encodeURIComponent(trackUuid)}/favorite`);
  const init = (t: string): RequestInit => ({
    method: "POST",
    headers: { Authorization: `Bearer ${t}` },
  });
  let r = await fetch(url, init(token));
  if (r.status === 401) {
    if (await refreshSessionIfPossible()) {
      token = getAccessToken();
      if (token) r = await fetch(url, init(token));
    }
  }
  if (!r.ok) {
    if (r.status === 401) clearSession();
    throw new ApiRequestError(r.status, await parseErr(r));
  }
}

export async function apiRemoveMusicTrackFavorite(trackUuid: string): Promise<void> {
  await authDelete(apiUrl(`/api/music/tracks/${encodeURIComponent(trackUuid)}/favorite`));
}

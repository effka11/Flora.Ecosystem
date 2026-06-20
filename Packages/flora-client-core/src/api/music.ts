import { ApiRequestError } from "./errors.js";
import { apiUrl, authDelete, authGetArrayBuffer, authGetJson, authPostForm, authPostJson } from "./client.js";
import type {
  MusicArtistDetailDto,
  MusicArtistSummaryDto,
  MusicFlowTrackDto,
  MusicFlowWaveDto,
  MusicGenreCollectionDto,
  MusicGenreDto,
  MusicGenrePageDto,
  MusicPlaylistDetailDto,
  MusicPlaylistKind,
  MusicPlaylistSummaryDto,
  MusicSubgenreDto,
  MusicTrackDto,
  MusicTrackScope,
  PagedMusicTracksDto,
  TrackArtistCredit,
  TrackArtistCreditInput,
  TrackArtistJoiner,
} from "../contracts/music.js";

function readStr(o: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = o[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function readNum(o: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    const value = o[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function readBool(o: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    const value = o[key];
    if (typeof value === "boolean") return value;
  }
  return false;
}

function readArray(o: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    const value = o[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function objectOrEmpty(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
}

function parseScope(raw: string): MusicTrackScope {
  return raw === "platform" ? "platform" : "personal";
}

function parseTrackArtistJoiner(raw: string): TrackArtistJoiner {
  switch (raw) {
    case "And":
    case "Ft":
    case "Vs":
    case "Prod":
    case "Mix":
    case "Remix":
    case "Edit":
    case "Pres":
      return raw;
    default:
      return "None";
  }
}

function parseTrackArtistCredit(raw: unknown): TrackArtistCredit | null {
  const o = objectOrEmpty(raw);
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
  return raw.map(parseTrackArtistCredit).filter((item): item is TrackArtistCredit => item !== null);
}

function parseMusicTrack(raw: unknown): MusicTrackDto | null {
  const o = objectOrEmpty(raw);
  const trackUuid = readStr(o, ["trackUuid", "TrackUuid"]);
  if (!trackUuid) return null;
  return {
    trackUuid,
    scope: parseScope(readStr(o, ["scope", "Scope"])),
    title: readStr(o, ["title", "Title"]) || "Трек",
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
  const track = parseMusicTrack(raw);
  if (!track) return null;
  const o = objectOrEmpty(raw);
  return {
    trackUuid: track.trackUuid,
    title: track.title,
    artistDisplay: track.artistDisplay,
    artistCredits: track.artistCredits,
    genreId: track.genreId,
    licenseId: track.licenseId,
    coverColorId: track.coverColorId,
    trackKindId: track.trackKindId,
    hasCoverImage: track.hasCoverImage,
    durationMs: track.durationMs,
    createdAt: track.createdAt,
    publishedAt: readStr(o, ["publishedAt", "PublishedAt"]),
    isOwnedByCurrentUser: readBool(o, ["isOwnedByCurrentUser", "IsOwnedByCurrentUser"]),
  };
}

function parseMusicSubgenre(raw: unknown): MusicSubgenreDto | null {
  const o = objectOrEmpty(raw);
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
  const o = objectOrEmpty(raw);
  const id = readStr(o, ["id", "Id", "genreId", "GenreId"]);
  if (!id) return null;
  return {
    id,
    title: readStr(o, ["title", "Title", "name", "Name"]),
    description: readStr(o, ["description", "Description"]) || null,
    trackCount: readNum(o, ["trackCount", "TrackCount"]),
    subgenres: readArray(o, ["subgenres", "Subgenres"])
      .map(parseMusicSubgenre)
      .filter((item): item is MusicSubgenreDto => item !== null),
  };
}

function parseMusicGenreCollection(raw: unknown): MusicGenreCollectionDto | null {
  const o = objectOrEmpty(raw);
  const id = readStr(o, ["id", "Id", "collectionId", "CollectionId"]);
  if (!id) return null;
  return {
    id,
    title: readStr(o, ["title", "Title"]),
    tracks: readArray(o, ["tracks", "Tracks"])
      .map(parseMusicTrack)
      .filter((item): item is MusicTrackDto => item !== null),
  };
}

function parseMusicGenrePage(raw: unknown): MusicGenrePageDto | null {
  const o = objectOrEmpty(raw);
  const genre = parseMusicGenre(o.genre ?? o.Genre ?? raw);
  if (!genre) return null;
  const activeSubgenre = parseMusicSubgenre(o.activeSubgenre ?? o.ActiveSubgenre);
  const collections = readArray(o, ["collections", "Collections"])
    .map(parseMusicGenreCollection)
    .filter((item): item is MusicGenreCollectionDto => item !== null);
  return { genre, activeSubgenre, collections };
}

function parseMusicArtist(raw: unknown): MusicArtistSummaryDto | null {
  const o = objectOrEmpty(raw);
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
  const o = objectOrEmpty(raw);
  const rows = Array.isArray(raw) ? raw : readArray(o, ["tracks", "Tracks"]);
  const tracks = rows.map(parseMusicTrack).filter((item): item is MusicTrackDto => item !== null);
  return {
    tracks,
    totalCount: readNum(o, ["totalCount", "TotalCount"]) || tracks.length,
    page: readNum(o, ["page", "Page"]) || fallbackPage,
    pageSize: readNum(o, ["pageSize", "PageSize"]) || fallbackPageSize,
  };
}

function parsePlaylistSummary(raw: unknown): MusicPlaylistSummaryDto | null {
  const o = objectOrEmpty(raw);
  const id = readStr(o, ["id", "Id"]);
  if (!id) return null;
  const kindRaw = readStr(o, ["kind", "Kind"]);
  return {
    id,
    title: readStr(o, ["title", "Title"]),
    trackCount: readNum(o, ["trackCount", "TrackCount"]),
    kind: kindRaw === "user" ? "user" : ("system" satisfies MusicPlaylistKind),
    variant: readStr(o, ["variant", "Variant"]),
    canDelete: readBool(o, ["canDelete", "CanDelete"]),
    coverColorId: readStr(o, ["coverColorId", "CoverColorId"]) || null,
  };
}

function parsePlaylistDetail(raw: unknown): MusicPlaylistDetailDto | null {
  const summary = parsePlaylistSummary(raw);
  if (!summary) return null;
  const o = objectOrEmpty(raw);
  const tracks = readArray(o, ["tracks", "Tracks"])
    .map(parseMusicTrack)
    .filter((item): item is MusicTrackDto => item !== null);
  return { ...summary, tracks };
}

function parseTrackUuid(raw: unknown): string {
  const trackUuid = readStr(objectOrEmpty(raw), ["trackUuid", "TrackUuid"]);
  if (!trackUuid) throw new ApiRequestError(500, "Некорректный ответ сервера.");
  return trackUuid;
}

export function apiGetMusicTrackAudioUrl(trackUuid: string): string {
  return apiUrl(`/api/music/tracks/${encodeURIComponent(trackUuid)}/audio`);
}

export function apiGetMusicTrackCoverUrl(trackUuid: string): string {
  return apiUrl(`/api/music/tracks/${encodeURIComponent(trackUuid)}/cover`);
}

export function apiGetMusicArtistCoverUrl(artistUuid: string): string {
  return apiUrl(`/api/music/artists/${encodeURIComponent(artistUuid)}/cover`);
}

export async function apiGetMusicLibrary(): Promise<MusicTrackDto[]> {
  const raw = await authGetJson("/api/music/tracks/library");
  const rows = Array.isArray(raw) ? raw : readArray(objectOrEmpty(raw), ["items", "Items", "tracks", "Tracks"]);
  return rows.map(parseMusicTrack).filter((item): item is MusicTrackDto => item !== null);
}

export async function apiGetMusicGenreCatalog(): Promise<MusicGenreDto[]> {
  const raw = await authGetJson("/api/music/genres");
  const rows = Array.isArray(raw) ? raw : readArray(objectOrEmpty(raw), ["genres", "Genres"]);
  return rows.map(parseMusicGenre).filter((item): item is MusicGenreDto => item !== null);
}

export async function apiGetMusicGenrePage(genreId: string, subgenreId?: string): Promise<MusicGenrePageDto> {
  const query = new URLSearchParams();
  if (subgenreId) query.set("subgenreId", subgenreId);
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const parsed = parseMusicGenrePage(await authGetJson(`/api/music/genres/${encodeURIComponent(genreId)}${suffix}`));
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
  for (const trackUuid of params.excludeTrackUuids ?? []) query.append("exclude", trackUuid);

  const raw = await authGetJson(`/api/music/flow?${query.toString()}`);
  const o = objectOrEmpty(raw);
  const tracks = readArray(o, ["tracks", "Tracks"])
    .map(parseMusicFlowTrack)
    .filter((item): item is MusicFlowTrackDto => item !== null);
  return {
    tracks,
    generatedAt: readStr(o, ["generatedAt", "GeneratedAt"]),
    expiresAt: readStr(o, ["expiresAt", "ExpiresAt"]),
  };
}

export async function apiGetMusicPlaylists(): Promise<MusicPlaylistSummaryDto[]> {
  const raw = await authGetJson("/api/music/playlists");
  const rows = Array.isArray(raw) ? raw : readArray(objectOrEmpty(raw), ["playlists", "Playlists"]);
  return rows.map(parsePlaylistSummary).filter((item): item is MusicPlaylistSummaryDto => item !== null);
}

export async function apiGetMusicPlaylistDetail(playlistId: string): Promise<MusicPlaylistDetailDto> {
  const parsed = parsePlaylistDetail(await authGetJson(`/api/music/playlists/${encodeURIComponent(playlistId)}`));
  if (!parsed) throw new ApiRequestError(500, "Некорректный ответ сервера.");
  return parsed;
}

export async function apiCreateMusicPlaylist(title: string): Promise<string> {
  const raw = await authPostJson("/api/music/playlists", { title });
  return readStr(objectOrEmpty(raw), ["playlistId", "PlaylistId", "id", "Id"]);
}

export async function apiDeleteMusicPlaylist(playlistId: string): Promise<void> {
  await authDelete(`/api/music/playlists/${encodeURIComponent(playlistId)}`);
}

export async function apiDeleteMusicTrack(trackUuid: string): Promise<void> {
  await authDelete(`/api/music/tracks/${encodeURIComponent(trackUuid)}`);
}

export async function apiGetMusicArtists(take?: number): Promise<MusicArtistSummaryDto[]> {
  const query = new URLSearchParams();
  if (take !== undefined) query.set("take", String(Math.max(1, Math.round(take))));
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  const raw = await authGetJson(`/api/music/artists${suffix}`);
  const rows = Array.isArray(raw) ? raw : readArray(objectOrEmpty(raw), ["artists", "Artists"]);
  return rows.map(parseMusicArtist).filter((item): item is MusicArtistSummaryDto => item !== null);
}

export async function apiSearchMusicArtists(q: string, limit?: number): Promise<MusicArtistSummaryDto[]> {
  const query = new URLSearchParams();
  query.set("q", q);
  if (limit !== undefined) query.set("limit", String(Math.max(1, Math.round(limit))));
  const raw = await authGetJson(`/api/music/artists/search?${query.toString()}`);
  const rows = Array.isArray(raw) ? raw : readArray(objectOrEmpty(raw), ["artists", "Artists", "results", "Results"]);
  return rows.map(parseMusicArtist).filter((item): item is MusicArtistSummaryDto => item !== null);
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
  const parsed = parseMusicArtist(await authPostForm("/api/music/artists", form));
  if (!parsed) throw new ApiRequestError(500, "Некорректный ответ сервера.");
  return parsed;
}

export async function apiGetMusicArtist(artistUuid: string): Promise<MusicArtistDetailDto> {
  const parsed = parseMusicArtist(await authGetJson(`/api/music/artists/${encodeURIComponent(artistUuid)}`));
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
  const raw = await authGetJson(`/api/music/artists/${encodeURIComponent(artistUuid)}/tracks?${query.toString()}`);
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
  return parseTrackUuid(await authPostForm("/api/music/tracks/self", form));
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
  return parseTrackUuid(await authPostForm("/api/music/tracks/platform", form));
}

export async function apiFetchMusicTrackAudioBytes(trackUuid: string): Promise<ArrayBuffer> {
  return authGetArrayBuffer(`/api/music/tracks/${encodeURIComponent(trackUuid)}/audio`);
}

export async function apiFetchMusicTrackCoverBytes(trackUuid: string): Promise<ArrayBuffer> {
  return authGetArrayBuffer(`/api/music/tracks/${encodeURIComponent(trackUuid)}/cover`);
}

export async function apiFetchMusicArtistCoverBytes(artistUuid: string): Promise<ArrayBuffer> {
  return authGetArrayBuffer(`/api/music/artists/${encodeURIComponent(artistUuid)}/cover`);
}

export async function apiAddMusicTrackFavorite(trackUuid: string): Promise<void> {
  await authPostJson(`/api/music/tracks/${encodeURIComponent(trackUuid)}/favorite`, {});
}

export async function apiRemoveMusicTrackFavorite(trackUuid: string): Promise<void> {
  await authDelete(`/api/music/tracks/${encodeURIComponent(trackUuid)}/favorite`);
}

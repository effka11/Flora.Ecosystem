import { asRecord, readBool, readNum, readStr, type ParseContext } from "./parse.js";

export type MusicTrackScope = "personal" | "platform";

export type TrackArtistJoiner =
  | "None"
  | "And"
  | "Ft"
  | "Vs"
  | "Prod"
  | "Mix"
  | "Remix"
  | "Edit"
  | "Pres";

export type TrackArtistCreditInput = {
  artistUuid: string;
  joinerBefore: TrackArtistJoiner;
};

export type TrackArtistCredit = {
  artistUuid: string;
  displayName: string;
  joinerBefore: TrackArtistJoiner;
};

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

export type MusicArtistSummaryDto = {
  artistUuid: string;
  displayName: string;
  linkedUserUuid: string | null;
  createdByUserUuid: string;
  tracksCount: number;
  hasCoverImage: boolean;
};

export type MusicArtistDetailDto = MusicArtistSummaryDto;

export type PagedMusicTracksDto = {
  tracks: MusicTrackDto[];
  totalCount: number;
  page: number;
  pageSize: number;
};

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

function parseTrackArtistCredit(raw: unknown, ctx?: ParseContext): TrackArtistCredit | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const artistUuid = readStr(o, ["artistUuid", "ArtistUuid"], fb);
  if (!artistUuid) return null;
  return {
    artistUuid,
    displayName: readStr(o, ["displayName", "DisplayName"], fb),
    joinerBefore: parseTrackArtistJoiner(readStr(o, ["joinerBefore", "JoinerBefore"], fb)),
  };
}

function parseTrackArtistCredits(raw: unknown, ctx?: ParseContext): TrackArtistCredit[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => parseTrackArtistCredit(item, ctx))
    .filter((item): item is TrackArtistCredit => item !== null);
}

export function parseMusicTrack(raw: unknown, ctx?: ParseContext): MusicTrackDto | null {
  const o = asRecord(raw);
  if (!o) return null;
  const fb = ctx?.onPascalFallback;
  const trackUuid = readStr(o, ["trackUuid", "TrackUuid"], fb);
  if (!trackUuid) return null;
  return {
    trackUuid,
    scope: parseScope(readStr(o, ["scope", "Scope"], fb)),
    title: readStr(o, ["title", "Title"], fb) || "Трек",
    artistDisplay: readStr(o, ["artistDisplay", "ArtistDisplay"], fb),
    artistCredits: parseTrackArtistCredits(o.artistCredits ?? o.ArtistCredits, ctx),
    tags: readStr(o, ["tags", "Tags"], fb) || null,
    genreId: readStr(o, ["genreId", "GenreId"], fb) || null,
    licenseId: readStr(o, ["licenseId", "LicenseId"], fb) || null,
    coverColorId: readStr(o, ["coverColorId", "CoverColorId"], fb) || null,
    trackKindId: readStr(o, ["trackKindId", "TrackKindId"], fb) || null,
    hasCoverImage: readBool(o, ["hasCoverImage", "HasCoverImage"], fb),
    durationMs: readNum(o, ["durationMs", "DurationMs"], fb) ?? 0,
    createdAt: readStr(o, ["createdAt", "CreatedAt"], fb),
    publishedAt: readStr(o, ["publishedAt", "PublishedAt"], fb) || null,
  };
}

/** Bare JSON array of MusicTrackDto. Objects like `{ items }` or paged wrappers yield []. */
export function parseMusicTracksList(raw: unknown, ctx?: ParseContext): MusicTrackDto[] {
  if (!Array.isArray(raw)) return [];
  const out: MusicTrackDto[] = [];
  for (const item of raw) {
    const parsed = parseMusicTrack(item, ctx);
    if (parsed) out.push(parsed);
  }
  return out;
}

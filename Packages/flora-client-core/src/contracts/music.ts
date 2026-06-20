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

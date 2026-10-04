import {
  coverColorIdToColor,
  FLORA_DEFAULT_COVER_ID,
  FLORA_DEFAULT_COVERS,
} from "@flora/client-core/display";

export type MusicGenreItem = {
  id: string;
  title: string;
};

export const MUSIC_GENRES: readonly MusicGenreItem[] = [
  { id: "pop", title: "Поп" },
  { id: "hiphop", title: "Хип-хоп" },
  { id: "electronics", title: "Электроника" },
  { id: "rock", title: "Рок" },
  { id: "instrumental", title: "Инструментальная" },
  { id: "jazz", title: "Джаз" },
  { id: "folk", title: "Фолк" },
  { id: "rnb", title: "R&B" },
] as const;

export const MUSIC_DEFAULT_COVER_ID = FLORA_DEFAULT_COVER_ID;
export const MUSIC_DEFAULT_COVERS = FLORA_DEFAULT_COVERS;
export { coverColorIdToColor };

export type MusicTrackKindId =
  | "song"
  | "podcast"
  | "mic"
  | "mixer"
  | "idea"
  | "live"
  | "demo"
  | "art";

export type MusicTrackKind = {
  id: MusicTrackKindId;
  label: string;
};

export const MUSIC_TRACK_KINDS: readonly MusicTrackKind[] = [
  { id: "song", label: "Нота" },
  { id: "podcast", label: "Наушники" },
  { id: "mic", label: "Микрофон" },
  { id: "mixer", label: "Микшер" },
  { id: "idea", label: "Лампочка" },
  { id: "live", label: "Лайв" },
  { id: "demo", label: "Демо" },
  { id: "art", label: "Арт" },
] as const;

export const MUSIC_DEFAULT_TRACK_KIND_ID: MusicTrackKindId = "song";

export const MUSIC_LICENSE_OPTIONS = [
  { id: "all_rights_reserved", label: "All Rights Reserved" },
  { id: "cc_by", label: "CC BY" },
  { id: "cc_by_nc", label: "CC BY-NC" },
  { id: "cc_by_nd", label: "CC BY-ND" },
  { id: "cc_by_nc_nd", label: "CC BY-NC-ND" },
  { id: "cc0", label: "CC0" },
] as const;

const TRACK_KIND_IDS = new Set<string>(MUSIC_TRACK_KINDS.map((kind) => kind.id));

export function parseMusicTrackKindId(value: string | null | undefined): MusicTrackKindId {
  if (value && TRACK_KIND_IDS.has(value)) return value as MusicTrackKindId;
  return MUSIC_DEFAULT_TRACK_KIND_ID;
}

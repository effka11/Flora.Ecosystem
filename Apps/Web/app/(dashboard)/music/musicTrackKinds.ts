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

/** Тип загружаемой записи (форма «Загрузить для себя»), палитра 2×4. */
export const MUSIC_TRACK_KINDS: MusicTrackKind[] = [
  { id: "song", label: "Нота" },
  { id: "podcast", label: "Наушники" },
  { id: "mic", label: "Микрофон" },
  { id: "mixer", label: "Микшер" },
  { id: "idea", label: "Лампочка" },
  { id: "live", label: "Лайв" },
  { id: "demo", label: "Демо" },
  { id: "art", label: "Арт" }
];

export const MUSIC_DEFAULT_TRACK_KIND_ID: MusicTrackKindId = "song";

const TRACK_KIND_IDS = new Set<string>(MUSIC_TRACK_KINDS.map((kind) => kind.id));

export function parseMusicTrackKindId(value: string | null | undefined): MusicTrackKindId {
  if (value && TRACK_KIND_IDS.has(value)) return value as MusicTrackKindId;
  return MUSIC_DEFAULT_TRACK_KIND_ID;
}

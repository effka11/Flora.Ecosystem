import { coverColorIdToColor } from "@/app/(dashboard)/music/musicDefaultCovers";
import type { MusicTrackKindId } from "@/app/(dashboard)/music/musicTrackKinds";
import type { TrackArtistCredit } from "@/lib/musicApi";

export type TrackSource = "uploaded" | "platform";

export type MusicTrackItem = {
  id: string;
  source: TrackSource;
  title: string;
  artist: string;
  artistCredits: TrackArtistCredit[];
  durationSeconds: number;
  coverColor: string;
  trackKindId: MusicTrackKindId;
  hasCoverImage?: boolean;
  /** Публичная загрузка текущего пользователя на площадку. */
  isOwnPlatformUpload?: boolean;
};

const UPLOADED_FIXTURES: Omit<MusicTrackItem, "id" | "source">[] = [
  {
    title: "Ночной эфир",
    artist: "Вы",
    artistCredits: [],
    durationSeconds: 214,
    coverColor: coverColorIdToColor("forest"),
    trackKindId: "song",
  },
  {
    title: "Черновик v3",
    artist: "Вы",
    artistCredits: [],
    durationSeconds: 187,
    coverColor: coverColorIdToColor("clay"),
    trackKindId: "demo",
  },
  {
    title: "Демо без названия",
    artist: "Вы",
    artistCredits: [],
    durationSeconds: 96,
    coverColor: coverColorIdToColor("dusk"),
    trackKindId: "mic",
  },
  {
    title: "Запись с телефона",
    artist: "Вы",
    artistCredits: [],
    durationSeconds: 302,
    coverColor: coverColorIdToColor("ember"),
    trackKindId: "live",
  },
];

/** Только для локальной разработки. */
const DEV_TRACKS: MusicTrackItem[] = [
  {
    id: "dev-platform-1",
    source: "platform",
    title: "Полярная ночь",
    artist: "Aurora Lane",
    artistCredits: [],
    durationSeconds: 245,
    coverColor: coverColorIdToColor("slate"),
    trackKindId: "song",
  },
  {
    id: "dev-platform-2",
    source: "platform",
    title: "Северный ветер",
    artist: "Kite & Glass",
    artistCredits: [],
    durationSeconds: 198,
    coverColor: coverColorIdToColor("slate"),
    trackKindId: "podcast",
  },
  {
    id: "dev-uploaded-1",
    source: "uploaded",
    title: "Лофи-скетч",
    artist: "Вы",
    artistCredits: [],
    durationSeconds: 164,
    coverColor: coverColorIdToColor("forest"),
    trackKindId: "art",
  },
  {
    id: "dev-platform-3",
    source: "platform",
    title: "Метро в 2:14",
    artist: "Subline",
    artistCredits: [],
    durationSeconds: 221,
    coverColor: coverColorIdToColor("ochre"),
    trackKindId: "song",
  },
  {
    id: "dev-platform-4",
    source: "platform",
    title: "Тихий зал",
    artist: "Roomtone",
    artistCredits: [],
    durationSeconds: 176,
    coverColor: coverColorIdToColor("forest"),
    trackKindId: "idea",
  },
  {
    id: "dev-platform-5",
    source: "platform",
    title: "После дождя",
    artist: "Moss Field",
    artistCredits: [],
    durationSeconds: 267,
    coverColor: coverColorIdToColor("forest"),
    trackKindId: "mixer",
  },
];

const DEV_COVER_IDS = ["wine", "ember", "clay", "ochre", "forest", "slate", "dusk", "ink"] as const;
const DEV_KIND_IDS: MusicTrackKindId[] = ["song", "podcast", "mic", "mixer", "idea", "live", "demo", "art"];

export function formatTrackDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/**
 * Загруженные треки — по uploadedTrackCount.
 * Тестовые строки — только в development.
 */
export function buildMyMusicTracks(uploadedTrackCount: number): MusicTrackItem[] {
  const list: MusicTrackItem[] = [];
  const count = Math.max(0, Math.floor(uploadedTrackCount));

  for (let i = 0; i < count; i++) {
    const fixture = UPLOADED_FIXTURES[i];
    if (fixture) {
      list.push({ id: `uploaded-${i}`, source: "uploaded", ...fixture });
    } else {
      list.push({
        id: `uploaded-${i}`,
        source: "uploaded",
        title: `Загрузка ${i + 1}`,
        artist: "Вы",
        artistCredits: [],
        durationSeconds: 180 + i * 17,
        coverColor: coverColorIdToColor(DEV_COVER_IDS[i % DEV_COVER_IDS.length]),
        trackKindId: DEV_KIND_IDS[i % DEV_KIND_IDS.length]!,
      });
    }
  }

  if (process.env.NODE_ENV === "development") {
    list.push(...DEV_TRACKS);
  }

  return list;
}

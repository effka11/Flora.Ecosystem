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

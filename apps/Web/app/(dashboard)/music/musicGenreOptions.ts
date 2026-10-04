export type MusicSubgenreOption = {
  id: string;
  label: string;
};

export type MusicGenreGroup = {
  id: string;
  label: string;
  subgenres: MusicSubgenreOption[];
};

/** Категория → поджанры для формы загрузки на площадку. */
export const MUSIC_GENRE_GROUPS: MusicGenreGroup[] = [
  {
    id: "pop",
    label: "Поп",
    subgenres: [
      { id: "pop-indie", label: "Инди-поп" },
      { id: "pop-synth", label: "Синти-поп" },
      { id: "pop-dream", label: "Дрим-поп" },
      { id: "pop-art", label: "Арт-поп" },
      { id: "pop-dance", label: "Данс-поп" },
      { id: "pop-baroque", label: "Барокко-поп" },
      { id: "pop-sophisti", label: "Софисти-поп" },
      { id: "pop-rock", label: "Поп-рок" },
    ],
  },
  {
    id: "hiphop",
    label: "Хип-хоп",
    subgenres: [
      { id: "hiphop-boom-bap", label: "Бум-бэп" },
      { id: "hiphop-trap", label: "Трэп" },
      { id: "hiphop-jazz-rap", label: "Джаз-рэп" },
      { id: "hiphop-lofi", label: "Лоуфай хип-хоп" },
      { id: "hiphop-abstract", label: "Абстрактный хип-хоп" },
      { id: "hiphop-grime", label: "Грайм" },
      { id: "hiphop-drill", label: "Дрилл" },
      { id: "hiphop-underground", label: "Андерграунд" },
    ],
  },
  {
    id: "electronics",
    label: "Электроника",
    subgenres: [
      { id: "electronics-house", label: "Хаус" },
      { id: "electronics-techno", label: "Техно" },
      { id: "electronics-ambient", label: "Эмбиент" },
      { id: "electronics-idm", label: "IDM" },
      { id: "electronics-downtempo", label: "Даунтемпо" },
      { id: "electronics-breakbeat", label: "Брейкбит" },
      { id: "electronics-dnb", label: "Драм-н-бейс" },
      { id: "electronics-trance", label: "Транс" },
    ],
  },
  {
    id: "rock",
    label: "Рок",
    subgenres: [
      { id: "rock-indie", label: "Инди-рок" },
      { id: "rock-alt", label: "Альтернативный рок" },
      { id: "rock-synth", label: "Синт рок" },
      { id: "rock-post-punk", label: "Пост-панк" },
      { id: "rock-hard", label: "Хард-рок" },
      { id: "rock-shoegaze", label: "Шугейз" },
      { id: "rock-metal", label: "Метал" },
      { id: "rock-punk", label: "Панк-рок" },
      { id: "rock-folk", label: "Фолк-рок" },
    ],
  },
  {
    id: "rnb",
    label: "R&B",
    subgenres: [
      { id: "rnb-neosoul", label: "Неосоул" },
      { id: "rnb-alt", label: "Альтернативный R&B" },
      { id: "rnb-contemporary", label: "Современный R&B" },
      { id: "rnb-classic-soul", label: "Классический соул" },
      { id: "rnb-funk", label: "Фанк" },
      { id: "rnb-new-jack", label: "Нью-джек-свинг" },
      { id: "rnb-crank", label: "Кранк" },
      { id: "rnb-dream-soul", label: "Дрим-соул" },
    ],
  },
  {
    id: "jazz",
    label: "Джаз",
    subgenres: [
      { id: "jazz-bebop", label: "Бибоп" },
      { id: "jazz-cool", label: "Кул-джаз" },
      { id: "jazz-fusion", label: "Фьюжн" },
      { id: "jazz-smooth", label: "Смус-джаз" },
      { id: "jazz-modal", label: "Модальный джаз" },
      { id: "jazz-latin", label: "Латин-джаз" },
      { id: "jazz-funk", label: "Джаз-фанк" },
      { id: "jazz-nu", label: "Ню-джаз" },
    ],
  },
  {
    id: "folk",
    label: "Фолк",
    subgenres: [
      { id: "folk-indie", label: "Инди-фолк" },
      { id: "folk-neo", label: "Неофолк" },
      { id: "folk-acoustic", label: "Акустический фолк" },
      { id: "folk-country", label: "Кантри" },
      { id: "folk-americana", label: "Американа" },
      { id: "folk-ethno", label: "Этно" },
      { id: "folk-celtic", label: "Кельтский фолк" },
      { id: "folk-dark", label: "Дарк-фолк" },
    ],
  },
  {
    id: "instrumental",
    label: "Инструментальная",
    subgenres: [
      { id: "instrumental-neoclassical", label: "Неоклассика" },
      { id: "instrumental-soundtrack", label: "Саундтрек" },
      { id: "instrumental-post-rock", label: "Пост-рок" },
      { id: "instrumental-ambient", label: "Эмбиент" },
      { id: "instrumental-minimal", label: "Минимализм" },
      { id: "instrumental-new-age", label: "Нью-эйдж" },
      { id: "instrumental-hiphop", label: "Инструментальный хип-хоп" },
      { id: "instrumental-acoustic-guitar", label: "Акустическая гитара" },
    ],
  },
];

export function findGenreGroupById(categoryId: string): MusicGenreGroup | undefined {
  return MUSIC_GENRE_GROUPS.find((group) => group.id === categoryId);
}

export function findSubgenreById(
  subgenreId: string,
): (MusicSubgenreOption & { groupId: string; groupLabel: string }) | undefined {
  for (const group of MUSIC_GENRE_GROUPS) {
    const subgenre = group.subgenres.find((item) => item.id === subgenreId);
    if (subgenre) {
      return {
        ...subgenre,
        groupId: group.id,
        groupLabel: group.label,
      };
    }
  }
  return undefined;
}

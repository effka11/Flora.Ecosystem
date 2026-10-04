//! Статическая таксономия жанров — порт `MusicGenreCatalog.cs` (зеркало Web musicGenreOptions).

#[derive(Debug, Clone, Copy)]
pub struct SubgenreEntry {
    pub id: &'static str,
    pub title: &'static str,
}

#[derive(Debug, Clone, Copy)]
pub struct GenreEntry {
    pub id: &'static str,
    pub title: &'static str,
    pub subgenres: &'static [SubgenreEntry],
}

macro_rules! sub {
    ($(($id:literal, $title:literal)),* $(,)?) => {
        &[$(SubgenreEntry { id: $id, title: $title },)*]
    };
}

pub static ENTRIES: &[GenreEntry] = &[
    GenreEntry {
        id: "pop",
        title: "Поп",
        subgenres: sub![
            ("pop-indie", "Инди-поп"),
            ("pop-synth", "Синти-поп"),
            ("pop-dream", "Дрим-поп"),
            ("pop-art", "Арт-поп"),
            ("pop-dance", "Данс-поп"),
            ("pop-baroque", "Барокко-поп"),
            ("pop-sophisti", "Софисти-поп"),
            ("pop-rock", "Поп-рок"),
        ],
    },
    GenreEntry {
        id: "hiphop",
        title: "Хип-хоп",
        subgenres: sub![
            ("hiphop-boom-bap", "Бум-бэп"),
            ("hiphop-trap", "Трэп"),
            ("hiphop-jazz-rap", "Джаз-рэп"),
            ("hiphop-lofi", "Лоуфай хип-хоп"),
            ("hiphop-abstract", "Абстрактный хип-хоп"),
            ("hiphop-grime", "Грайм"),
            ("hiphop-drill", "Дрилл"),
            ("hiphop-underground", "Андерграунд"),
        ],
    },
    GenreEntry {
        id: "electronics",
        title: "Электроника",
        subgenres: sub![
            ("electronics-house", "Хаус"),
            ("electronics-techno", "Техно"),
            ("electronics-ambient", "Эмбиент"),
            ("electronics-idm", "IDM"),
            ("electronics-downtempo", "Даунтемпо"),
            ("electronics-breakbeat", "Брейкбит"),
            ("electronics-dnb", "Драм-н-бейс"),
            ("electronics-trance", "Транс"),
        ],
    },
    GenreEntry {
        id: "rock",
        title: "Рок",
        subgenres: sub![
            ("rock-indie", "Инди-рок"),
            ("rock-alt", "Альтернативный рок"),
            ("rock-synth", "Синт рок"),
            ("rock-post-punk", "Пост-панк"),
            ("rock-hard", "Хард-рок"),
            ("rock-shoegaze", "Шугейз"),
            ("rock-metal", "Метал"),
            ("rock-punk", "Панк-рок"),
            ("rock-folk", "Фолк-рок"),
        ],
    },
    GenreEntry {
        id: "rnb",
        title: "R&B",
        subgenres: sub![
            ("rnb-neosoul", "Неосоул"),
            ("rnb-alt", "Альтернативный R&B"),
            ("rnb-contemporary", "Современный R&B"),
            ("rnb-classic-soul", "Классический соул"),
            ("rnb-funk", "Фанк"),
            ("rnb-new-jack", "Нью-джек-свинг"),
            ("rnb-crank", "Кранк"),
            ("rnb-dream-soul", "Дрим-соул"),
        ],
    },
    GenreEntry {
        id: "jazz",
        title: "Джаз",
        subgenres: sub![
            ("jazz-bebop", "Бибоп"),
            ("jazz-cool", "Кул-джаз"),
            ("jazz-fusion", "Фьюжн"),
            ("jazz-smooth", "Смус-джаз"),
            ("jazz-modal", "Модальный джаз"),
            ("jazz-latin", "Латин-джаз"),
            ("jazz-funk", "Джаз-фанк"),
            ("jazz-nu", "Ню-джаз"),
        ],
    },
    GenreEntry {
        id: "folk",
        title: "Фолк",
        subgenres: sub![
            ("folk-indie", "Инди-фолк"),
            ("folk-neo", "Неофолк"),
            ("folk-acoustic", "Акустический фолк"),
            ("folk-country", "Кантри"),
            ("folk-americana", "Американа"),
            ("folk-ethno", "Этно"),
            ("folk-celtic", "Кельтский фолк"),
            ("folk-dark", "Дарк-фолк"),
        ],
    },
    GenreEntry {
        id: "instrumental",
        title: "Инструментальная",
        subgenres: sub![
            ("instrumental-neoclassical", "Неоклассика"),
            ("instrumental-soundtrack", "Саундтрек"),
            ("instrumental-post-rock", "Пост-рок"),
            ("instrumental-ambient", "Эмбиент"),
            ("instrumental-minimal", "Минимализм"),
            ("instrumental-new-age", "Нью-эйдж"),
            ("instrumental-hiphop", "Инструментальный хип-хоп"),
            ("instrumental-acoustic-guitar", "Акустическая гитара"),
        ],
    },
];

pub fn find_genre(genre_id: &str) -> Option<&'static GenreEntry> {
    ENTRIES.iter().find(|g| g.id.eq_ignore_ascii_case(genre_id))
}

pub fn find_subgenre(genre_id: &str, subgenre_id: &str) -> Option<&'static SubgenreEntry> {
    find_genre(genre_id).and_then(|g| {
        g.subgenres
            .iter()
            .find(|s| s.id.eq_ignore_ascii_case(subgenre_id))
    })
}

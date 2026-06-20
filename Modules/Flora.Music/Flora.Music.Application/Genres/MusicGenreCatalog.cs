namespace Flora.Music.Application.Genres;

public sealed record MusicGenreCatalogEntry(string Id, string Title, IReadOnlyList<MusicSubgenreCatalogEntry> Subgenres);

public sealed record MusicSubgenreCatalogEntry(string Id, string Title);

/// <summary>
/// Module-owned taxonomy mirrored from Apps/Web musicGenreOptions.ts.
/// </summary>
public static class MusicGenreCatalog
{
    public static readonly IReadOnlyList<MusicGenreCatalogEntry> Entries =
    [
        new("pop", "Поп",
        [
            new("pop-indie", "Инди-поп"),
            new("pop-synth", "Синти-поп"),
            new("pop-dream", "Дрим-поп"),
            new("pop-art", "Арт-поп"),
            new("pop-dance", "Данс-поп"),
            new("pop-baroque", "Барокко-поп"),
            new("pop-sophisti", "Софисти-поп"),
            new("pop-rock", "Поп-рок"),
        ]),
        new("hiphop", "Хип-хоп",
        [
            new("hiphop-boom-bap", "Бум-бэп"),
            new("hiphop-trap", "Трэп"),
            new("hiphop-jazz-rap", "Джаз-рэп"),
            new("hiphop-lofi", "Лоуфай хип-хоп"),
            new("hiphop-abstract", "Абстрактный хип-хоп"),
            new("hiphop-grime", "Грайм"),
            new("hiphop-drill", "Дрилл"),
            new("hiphop-underground", "Андерграунд"),
        ]),
        new("electronics", "Электроника",
        [
            new("electronics-house", "Хаус"),
            new("electronics-techno", "Техно"),
            new("electronics-ambient", "Эмбиент"),
            new("electronics-idm", "IDM"),
            new("electronics-downtempo", "Даунтемпо"),
            new("electronics-breakbeat", "Брейкбит"),
            new("electronics-dnb", "Драм-н-бейс"),
            new("electronics-trance", "Транс"),
        ]),
        new("rock", "Рок",
        [
            new("rock-indie", "Инди-рок"),
            new("rock-alt", "Альтернативный рок"),
            new("rock-synth", "Синт рок"),
            new("rock-post-punk", "Пост-панк"),
            new("rock-hard", "Хард-рок"),
            new("rock-shoegaze", "Шугейз"),
            new("rock-metal", "Метал"),
            new("rock-punk", "Панк-рок"),
            new("rock-folk", "Фолк-рок"),
        ]),
        new("rnb", "R&B",
        [
            new("rnb-neosoul", "Неосоул"),
            new("rnb-alt", "Альтернативный R&B"),
            new("rnb-contemporary", "Современный R&B"),
            new("rnb-classic-soul", "Классический соул"),
            new("rnb-funk", "Фанк"),
            new("rnb-new-jack", "Нью-джек-свинг"),
            new("rnb-crank", "Кранк"),
            new("rnb-dream-soul", "Дрим-соул"),
        ]),
        new("jazz", "Джаз",
        [
            new("jazz-bebop", "Бибоп"),
            new("jazz-cool", "Кул-джаз"),
            new("jazz-fusion", "Фьюжн"),
            new("jazz-smooth", "Смус-джаз"),
            new("jazz-modal", "Модальный джаз"),
            new("jazz-latin", "Латин-джаз"),
            new("jazz-funk", "Джаз-фанк"),
            new("jazz-nu", "Ню-джаз"),
        ]),
        new("folk", "Фолк",
        [
            new("folk-indie", "Инди-фолк"),
            new("folk-neo", "Неофолк"),
            new("folk-acoustic", "Акустический фолк"),
            new("folk-country", "Кантри"),
            new("folk-americana", "Американа"),
            new("folk-ethno", "Этно"),
            new("folk-celtic", "Кельтский фолк"),
            new("folk-dark", "Дарк-фолк"),
        ]),
        new("instrumental", "Инструментальная",
        [
            new("instrumental-neoclassical", "Неоклассика"),
            new("instrumental-soundtrack", "Саундтрек"),
            new("instrumental-post-rock", "Пост-рок"),
            new("instrumental-ambient", "Эмбиент"),
            new("instrumental-minimal", "Минимализм"),
            new("instrumental-new-age", "Нью-эйдж"),
            new("instrumental-hiphop", "Инструментальный хип-хоп"),
            new("instrumental-acoustic-guitar", "Акустическая гитара"),
        ]),
    ];

    public static MusicGenreCatalogEntry? FindGenre(string genreId) =>
        Entries.FirstOrDefault(g => string.Equals(g.Id, genreId, StringComparison.OrdinalIgnoreCase));

    public static MusicSubgenreCatalogEntry? FindSubgenre(string genreId, string subgenreId)
    {
        var genre = FindGenre(genreId);
        return genre?.Subgenres.FirstOrDefault(s =>
            string.Equals(s.Id, subgenreId, StringComparison.OrdinalIgnoreCase));
    }
}

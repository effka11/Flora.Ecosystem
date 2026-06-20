"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type SVGProps,
} from "react";
import { useRouter } from "next/navigation";
import {
  GenreArtPop,
  GenreArtHipHop,
  GenreArtRock,
  GenreArtElectronics,
  GenreArtInstrumental,
  GenreArtJazz,
  GenreArtFolk,
  GenreArtRnB,
} from "@/app/(dashboard)/music/GenreArts";
import { MUSIC_GENRES } from "@/app/(dashboard)/music/musicGenres";
import { MusicFlowPlayer } from "@/app/(dashboard)/music/MusicFlowPlayer";
import { MusicTrackArtistLine } from "@/app/(dashboard)/music/MusicTrackArtistLine";
import { mapMusicTrackDtoToItem } from "@/app/(dashboard)/music/musicTrackMappers";
import { formatTrackDuration, type MusicTrackItem } from "@/app/(dashboard)/music/musicTracks";
import { mapMusicTrackItemsToPlayerTracks } from "@/app/(dashboard)/music/player/mapPlayerTrack";
import { useMusicPlayer } from "@/app/(dashboard)/music/player/MusicPlayerProvider";
import { TrackDefaultCoverArt } from "@/app/(dashboard)/music/TrackDefaultCoverArt";
import {
  type MusicGenreCollectionDto,
  type MusicGenreDto,
  type MusicGenrePageDto,
} from "@/lib/musicApi";
import {
  getMusicGenrePageCached,
  peekMusicGenrePage,
  prefetchMusicGenrePage,
  prefetchMusicGenreSubgenres,
  seedMusicGenrePageCache,
} from "@/lib/musicGenrePageCache";
import {
  ensureMusicTrackCoverObjectUrl,
  peekMusicTrackCoverObjectUrl,
  prefetchMusicTrackCoversFromCollections,
  prefetchMusicTrackCoversFromPage,
} from "@/lib/musicTrackCoverCache";
import { MUSIC_ROUTE_TRANSITION_CLEAR_MS } from "@/app/(dashboard)/music/musicRouteTransition";
import { prefersReducedDashboardMotion } from "@/app/_dashboard/dashboardRouteTransition";
import messageStyles from "@/app/(dashboard)/messages/messages.module.css";
import emptyHintStyles from "@/app/_shared/emptyPageHint.module.css";
import styles from "./music.module.css";

const GENRE_COLLECTIONS_TRANSITION_CLEAR_MS = MUSIC_ROUTE_TRANSITION_CLEAR_MS;

type GenreArtComponent = ComponentType<SVGProps<SVGSVGElement>>;

type GenreVariant =
  | "genreCardPop"
  | "genreCardHipHop"
  | "genreCardRock"
  | "genreCardElectronics"
  | "genreCardInstrumental"
  | "genreCardJazz"
  | "genreCardFolk"
  | "genreCardRnB";

type GenrePresentation = {
  Art: GenreArtComponent;
  variant: GenreVariant;
};

type GenreCollectionViewModel = {
  id: string;
  title: string;
  tracks: MusicTrackItem[];
};

export type MusicGenreViewProps = {
  genreId: string;
  subgenreId?: string;
  initialPage?: MusicGenrePageDto;
};

const GENRE_ARTS: Record<string, GenrePresentation> = {
  pop: { Art: GenreArtPop, variant: "genreCardPop" },
  hiphop: { Art: GenreArtHipHop, variant: "genreCardHipHop" },
  electronics: { Art: GenreArtElectronics, variant: "genreCardElectronics" },
  rock: { Art: GenreArtRock, variant: "genreCardRock" },
  instrumental: { Art: GenreArtInstrumental, variant: "genreCardInstrumental" },
  jazz: { Art: GenreArtJazz, variant: "genreCardJazz" },
  folk: { Art: GenreArtFolk, variant: "genreCardFolk" },
  rnb: { Art: GenreArtRnB, variant: "genreCardRnB" },
};

const FALLBACK_GENRE_ART: GenrePresentation = { Art: GenreArtPop, variant: "genreCardPop" };

const GENRE_COLLECTIONS = [
  { id: "popular", title: "Популярное" },
  { id: "new", title: "Новое" },
] as const;

const SUBGENRE_SCROLL_EDGE_EPS = 2;
const SUBGENRE_FADE_RANGE_CELLS = 4;

type ScrollArrows = { canScrollLeft: boolean; canScrollRight: boolean };
type SubgenreFadeStrength = { left: number; right: number };

function getGenrePresentation(genreId: string): GenrePresentation {
  return GENRE_ARTS[genreId] ?? FALLBACK_GENRE_ART;
}

function localGenreTitle(genreId: string): string {
  return MUSIC_GENRES.find((genre) => genre.id === genreId)?.title ?? genreId;
}

function normalizeCollectionId(id: string): string {
  const normalized = id.trim().toLowerCase();
  if (normalized === "newtracks" || normalized === "latest") return "new";
  if (normalized === "populartracks" || normalized === "trending") return "popular";
  return normalized;
}

function collectionTitle(id: string, fallback: string): string {
  return GENRE_COLLECTIONS.find((item) => item.id === id)?.title ?? fallback;
}

function genreFlowSubtitle(genre: MusicGenreDto, subgenreId?: string): string {
  const subgenreTitle = genre.subgenres.find((subgenre) => subgenre.id === subgenreId)?.title;
  return `По жанру ${[genre.title, subgenreTitle].filter(Boolean).join(" / ")}`;
}

function normalizeCollections(collections: MusicGenreCollectionDto[]): GenreCollectionViewModel[] {
  const byId = new Map(
    collections.map((collection) => {
      const id = normalizeCollectionId(collection.id);
      return [
        id,
        {
          id,
          title: collectionTitle(id, collection.title || collection.id),
          tracks: collection.tracks.map(mapMusicTrackDtoToItem),
        },
      ] as const;
    }),
  );

  return GENRE_COLLECTIONS.map((slot) => byId.get(slot.id) ?? { id: slot.id, title: slot.title, tracks: [] });
}

function MusicGenreCloseButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className={styles.playlistCloseBtn}
      aria-label="Закрыть жанр"
      onClick={onClick}
    >
      <svg className={styles.playlistCloseBtnIcon} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  );
}

function SubgenreNavChevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      className={styles.genresNavIcon}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        d={direction === "left" ? "M14.5 6.5 9 12l5.5 5.5" : "M9.5 6.5 15 12l-5.5 5.5"}
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function readSubgenreScrollArrows(el: HTMLElement): ScrollArrows {
  const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
  return {
    canScrollLeft: el.scrollLeft > SUBGENRE_SCROLL_EDGE_EPS,
    canScrollRight: maxScroll > SUBGENRE_SCROLL_EDGE_EPS && el.scrollLeft < maxScroll - SUBGENRE_SCROLL_EDGE_EPS,
  };
}

function readSubgenreFadeStrength(el: HTMLElement): SubgenreFadeStrength {
  const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
  if (maxScroll <= SUBGENRE_SCROLL_EDGE_EPS) {
    return { left: 0, right: 0 };
  }

  const step =
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--flora-grid-step")) || 15;
  const fadeRange = SUBGENRE_FADE_RANGE_CELLS * step;
  return {
    left: Math.min(1, el.scrollLeft / fadeRange),
    right: Math.min(1, (maxScroll - el.scrollLeft) / fadeRange),
  };
}

function MusicGenreSubgenres({
  genre,
  activeSubgenreId,
  onPrefetchSubgenre,
}: {
  genre: MusicGenreDto;
  activeSubgenreId?: string;
  onPrefetchSubgenre?: (subgenreId?: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [arrows, setArrows] = useState<ScrollArrows>({ canScrollLeft: false, canScrollRight: false });
  const [fade, setFade] = useState<SubgenreFadeStrength>({ left: 0, right: 0 });

  const syncScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setArrows(readSubgenreScrollArrows(el));
    setFade(readSubgenreFadeStrength(el));
  }, []);

  useEffect(() => {
    syncScrollState();
    const el = scrollRef.current;
    if (!el) return;

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncScrollState) : null;
    ro?.observe(el);
    window.addEventListener("resize", syncScrollState);

    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", syncScrollState);
    };
  }, [genre.subgenres.length, syncScrollState]);

  const scrollSubgenres = (direction: -1 | 1) => {
    const el = scrollRef.current;
    if (!el) return;
    const step = Math.max(el.clientWidth * 0.75, 160);
    el.scrollBy({ left: direction * step, behavior: "smooth" });
  };

  const leftActive = arrows.canScrollLeft;
  const rightActive = arrows.canScrollRight;

  return (
    <div className={styles.genreSubgenresCarousel}>
      <div className={styles.genreSubgenresHeader}>
        <div className={styles.genresNavGroup}>
          <button
            type="button"
            className={`${styles.genresNavBtn} ${!leftActive ? styles.genresNavBtnInactive : ""}`}
            aria-label="Предыдущие поджанры"
            aria-disabled={!leftActive}
            tabIndex={leftActive ? 0 : -1}
            onClick={() => scrollSubgenres(-1)}
          >
            <SubgenreNavChevron direction="left" />
          </button>
          <button
            type="button"
            className={`${styles.genresNavBtn} ${!rightActive ? styles.genresNavBtnInactive : ""}`}
            aria-label="Следующие поджанры"
            aria-disabled={!rightActive}
            tabIndex={rightActive ? 0 : -1}
            onClick={() => scrollSubgenres(1)}
          >
            <SubgenreNavChevron direction="right" />
          </button>
        </div>
      </div>
      <div
        className={styles.genreSubgenresScrollWrap}
        style={
          {
            "--genre-subgenres-fade-left": fade.left,
            "--genre-subgenres-fade-right": fade.right,
          } as CSSProperties
        }
      >
        <nav ref={scrollRef} className={styles.genreSubgenres} aria-label="Поджанры" onScroll={syncScrollState}>
          <div className={styles.genreSubgenresTrack}>
            <Link
              href={`/music/genre/${encodeURIComponent(genre.id)}`}
              scroll={false}
              className={styles.genreSubgenreChip}
              data-active={!activeSubgenreId ? "" : undefined}
              aria-current={!activeSubgenreId ? "page" : undefined}
              onPointerEnter={() => onPrefetchSubgenre?.()}
            >
              Всё
            </Link>
            {genre.subgenres.map((subgenre) => (
              <Link
                key={subgenre.id}
                href={`/music/genre/${encodeURIComponent(genre.id)}/${encodeURIComponent(subgenre.id)}`}
                scroll={false}
                className={styles.genreSubgenreChip}
                data-active={subgenre.id === activeSubgenreId ? "" : undefined}
                aria-current={subgenre.id === activeSubgenreId ? "page" : undefined}
                onPointerEnter={() => onPrefetchSubgenre?.(subgenre.id)}
              >
                {subgenre.title}
              </Link>
            ))}
          </div>
        </nav>
      </div>
    </div>
  );
}

function readTrackCoverUrls(tracks: MusicTrackItem[]): Record<string, string> {
  const next: Record<string, string> = {};
  for (const track of tracks) {
    if (!track.hasCoverImage) continue;
    const url = peekMusicTrackCoverObjectUrl(track.id);
    if (url) next[track.id] = url;
  }
  return next;
}

function GenreTrackCarousel({
  tracks,
  playbackSourceId,
}: {
  tracks: MusicTrackItem[];
  playbackSourceId: string;
}) {
  const { playQueue, togglePlay, isTrackActive, isTrackPlaying, busy } = useMusicPlayer();
  const playerTracks = useMemo(() => mapMusicTrackItemsToPlayerTracks(tracks), [tracks]);
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>(() => readTrackCoverUrls(tracks));

  useEffect(() => {
    let cancelled = false;
    const cached = readTrackCoverUrls(tracks);
    setCoverUrls(cached);

    void (async () => {
      const next = { ...cached };
      for (const track of tracks) {
        if (!track.hasCoverImage || next[track.id]) continue;
        try {
          next[track.id] = await ensureMusicTrackCoverObjectUrl(track.id);
        } catch {
          // Показываем цветовую заглушку.
        }
      }
      if (!cancelled) setCoverUrls(next);
    })();

    return () => {
      cancelled = true;
    };
  }, [tracks]);

  const handleToggle = useCallback(
    (track: MusicTrackItem, index: number) => {
      if (isTrackActive(track.id)) {
        togglePlay();
        return;
      }
      playQueue(playerTracks, index, { sourceId: playbackSourceId });
    },
    [isTrackActive, playQueue, playbackSourceId, playerTracks, togglePlay],
  );

  return (
    <div className={styles.genreTrackCarousel}>
      {tracks.map((track, index) => {
        const isPlaying = isTrackPlaying(track.id);
        const isLoading = busy && isTrackActive(track.id) && !isPlaying;
        return (
          <div key={track.id} className={styles.genreTrackCard}>
            <button
              type="button"
              className={styles.genreTrackCover}
              data-playing={isPlaying ? "" : undefined}
              aria-label={isPlaying ? `Пауза «${track.title}»` : `Слушать «${track.title}»`}
              aria-pressed={isPlaying}
              disabled={isLoading}
              onClick={() => handleToggle(track, index)}
            >
              {coverUrls[track.id] ? (
                <span
                  className={styles.genreTrackCoverArt}
                  style={{ backgroundImage: `url(${coverUrls[track.id]})` }}
                  aria-hidden
                />
              ) : (
                <TrackDefaultCoverArt coverColor={track.coverColor} trackKindId={track.trackKindId} />
              )}
              <span
                className={`${messageStyles.messagesBubbleTime} ${messageStyles.messagesBubblePhotoTime} ${styles.genreTrackCoverTime}`}
                aria-label="Длительность"
              >
                {formatTrackDuration(track.durationSeconds)}
              </span>
              <span className={styles.genreTrackPlay} data-playing={isPlaying ? "" : undefined} aria-hidden />
            </button>
            <div className={styles.genreTrackBody}>
              <span className={styles.genreTrackTitle}>{track.title}</span>
              <MusicTrackArtistLine
                artist={track.artist}
                artistCredits={track.artistCredits}
                className={`${styles.genreTrackArtist} flora-type-15`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function GenreCollectionSection({
  genreId,
  subgenreId,
  collection,
}: {
  genreId: string;
  subgenreId?: string;
  collection: GenreCollectionViewModel;
}) {
  const playbackSourceId = `genre:${genreId}:${subgenreId ?? "all"}:${collection.id}`;

  return (
    <section className={styles.genreCollectionSection} aria-labelledby={`genre-collection-${collection.id}`}>
      <div className={styles.genreCollectionHeader}>
        <h2 id={`genre-collection-${collection.id}`} className={styles.genreCollectionTitle}>
          {collection.title}
        </h2>
      </div>
      {collection.tracks.length > 0 ? (
        <GenreTrackCarousel tracks={collection.tracks} playbackSourceId={playbackSourceId} />
      ) : (
        <p className={`${styles.genreCollectionEmpty} flora-type-15`}>Здесь появятся треки жанра.</p>
      )}
    </section>
  );
}

export function MusicGenreView({ genreId, subgenreId, initialPage }: MusicGenreViewProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(() => initialPage == null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [collectionsError, setCollectionsError] = useState<string | null>(null);
  const [genre, setGenre] = useState<MusicGenreDto | null>(() => initialPage?.genre ?? null);
  const [collections, setCollections] = useState<GenreCollectionViewModel[]>(() =>
    initialPage ? normalizeCollections(initialPage.collections) : [],
  );
  const loadedGenreIdRef = useRef<string | null>(initialPage?.genre.id ?? null);
  const genreHydratedRef = useRef(initialPage?.genre != null);
  const collectionsSubgenreRef = useRef<string | undefined>(subgenreId);
  const collectionsTransitionClearRef = useRef<number | null>(null);
  const [collectionsAnimEpoch, setCollectionsAnimEpoch] = useState(0);
  const [collectionsPanelIn, setCollectionsPanelIn] = useState(false);

  const applyCollectionsTransition = useCallback(() => {
    if (prefersReducedDashboardMotion()) return;
    if (collectionsTransitionClearRef.current !== null) {
      window.clearTimeout(collectionsTransitionClearRef.current);
      collectionsTransitionClearRef.current = null;
    }
    setCollectionsAnimEpoch((epoch) => epoch + 1);
    setCollectionsPanelIn(true);
    collectionsTransitionClearRef.current = window.setTimeout(() => {
      setCollectionsPanelIn(false);
      collectionsTransitionClearRef.current = null;
    }, GENRE_COLLECTIONS_TRANSITION_CLEAR_MS);
  }, []);

  useEffect(
    () => () => {
      if (collectionsTransitionClearRef.current !== null) {
        window.clearTimeout(collectionsTransitionClearRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!initialPage) return;
    seedMusicGenrePageCache(genreId, subgenreId, initialPage);
  }, [genreId, initialPage, subgenreId]);

  useEffect(() => {
    if (initialPage) return undefined;
    let cancelled = false;

    const isSubgenreSwitch = genreHydratedRef.current && loadedGenreIdRef.current === genreId;
    const cached = peekMusicGenrePage(genreId, subgenreId);

    if (!isSubgenreSwitch) {
      if (cached) {
        setGenre(cached.genre);
        setCollections(normalizeCollections(cached.collections));
        loadedGenreIdRef.current = genreId;
        genreHydratedRef.current = true;
        setLoading(false);
        setLoadError(null);
        setCollectionsError(null);
      } else {
        setLoading(true);
        setLoadError(null);
        setCollectionsError(null);
      }
    } else {
      setCollectionsError(null);
      const subgenreChanged = collectionsSubgenreRef.current !== subgenreId;
      if (subgenreChanged) {
        collectionsSubgenreRef.current = subgenreId;
      }
      if (cached) {
        setCollections(normalizeCollections(cached.collections));
        if (subgenreChanged) applyCollectionsTransition();
      }
    }

    const shouldAnimateAfterFetch =
      isSubgenreSwitch && collectionsSubgenreRef.current === subgenreId && !cached;

    void (async () => {
      try {
        const page = await getMusicGenrePageCached(genreId, subgenreId);
        if (cancelled) return;

        if (isSubgenreSwitch) {
          setCollections(normalizeCollections(page.collections));
          setCollectionsError(null);
          if (shouldAnimateAfterFetch) applyCollectionsTransition();
        } else {
          setGenre(page.genre);
          setCollections(normalizeCollections(page.collections));
          loadedGenreIdRef.current = genreId;
          genreHydratedRef.current = true;
          setLoadError(null);
        }
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Не удалось загрузить жанр.";
        if (isSubgenreSwitch) {
          setCollectionsError(message);
        } else {
          setLoadError(message);
          setGenre(null);
          setCollections([]);
          loadedGenreIdRef.current = null;
          genreHydratedRef.current = false;
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [applyCollectionsTransition, genreId, initialPage, subgenreId]);

  const prefetchSubgenre = useCallback(
    (nextSubgenreId?: string) => {
      prefetchMusicGenrePage(genreId, nextSubgenreId);
      const cached = peekMusicGenrePage(genreId, nextSubgenreId);
      if (cached) prefetchMusicTrackCoversFromPage(cached);
    },
    [genreId],
  );

  useEffect(() => {
    if (!genre?.subgenres.length) return;
    prefetchMusicGenreSubgenres(
      genre.id,
      genre.subgenres.map((subgenre) => subgenre.id),
      { skipSubgenreId: subgenreId },
    );
  }, [genre?.id, genre?.subgenres, subgenreId]);

  useEffect(() => {
    if (!collections.length) return;
    prefetchMusicTrackCoversFromCollections(collections);
  }, [collections]);

  const handleExit = () => {
    router.push("/music", { scroll: false });
  };

  const displayGenre = genre
    ? { ...genre, title: genre.title || localGenreTitle(genre.id) }
    : { id: genreId, title: localGenreTitle(genreId), description: null, trackCount: 0, subgenres: [] };
  const { Art, variant } = getGenrePresentation(displayGenre.id);
  const hasSubgenres = displayGenre.subgenres.length > 0;
  const flowSubtitle = genreFlowSubtitle(displayGenre, subgenreId);

  return (
    <div className={styles.genrePageShell}>
      <MusicGenreCloseButton onClick={handleExit} />
      <div className={styles.genrePage}>
        {loading ? (
          <p className={`${emptyHintStyles.hint} ${emptyHintStyles.hintCentered}`}>Загрузка…</p>
        ) : loadError ? (
          <p className={`${emptyHintStyles.hint} ${emptyHintStyles.hintCentered}`} role="alert">
            {loadError}
          </p>
        ) : (
          <>
            <section className={styles.genreHero} aria-labelledby="music-genre-title">
              <div className={`${styles.genreHeroCover} ${styles[variant]}`} aria-hidden>
                <div className={styles.genreCardBg} />
                <Art className={styles.genreHeroArt} />
              </div>
              <div className={styles.genreHeroSide}>
                <div className={styles.genreHeroTop}>
                  <div className={styles.genreHeroInfo}>
                    <p className={`${styles.genreHeroKind} flora-type-15`}>Жанр</p>
                    <h1 id="music-genre-title" className={styles.genreHeroTitle}>
                      {displayGenre.title}
                    </h1>
                  </div>
                  <div className={styles.genreHeroFlowCard}>
                    <MusicFlowPlayer
                      genreId={displayGenre.id}
                      subgenreId={subgenreId}
                      title="Мой поток"
                      subtitle={flowSubtitle}
                      variant="genreMini"
                    />
                  </div>
                </div>
                {hasSubgenres ? (
                  <MusicGenreSubgenres
                    genre={displayGenre}
                    activeSubgenreId={subgenreId}
                    onPrefetchSubgenre={prefetchSubgenre}
                  />
                ) : null}
              </div>
            </section>

            <div className={styles.genreCollections}>
              {collectionsError ? (
                <p className={`${emptyHintStyles.hint} ${emptyHintStyles.hintCentered}`} role="alert">
                  {collectionsError}
                </p>
              ) : null}
              <div
                key={collectionsAnimEpoch}
                className={`${styles.genreCollectionsPanel} ${collectionsPanelIn ? styles.genreCollectionsPanelIn : ""}`}
              >
                {collections.map((collection) => (
                  <GenreCollectionSection
                    key={collection.id}
                    genreId={displayGenre.id}
                    subgenreId={subgenreId}
                    collection={collection}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

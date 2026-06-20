"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { mapMusicTrackDtoToItem } from "@/app/(dashboard)/music/musicTrackMappers";
import { MyMusicTracksList } from "@/app/(dashboard)/music/MyMusicTracksList";
import { mapMusicTrackItemsToPlayerTracks } from "@/app/(dashboard)/music/player/mapPlayerTrack";
import { useMusicPlayer } from "@/app/(dashboard)/music/player/MusicPlayerProvider";
import {
  apiFetchMusicArtistCoverBlob,
  apiGetMusicArtist,
  apiGetMusicArtistTracks,
  type MusicArtistDetailDto,
} from "@/lib/musicApi";
import emptyHintStyles from "@/app/_shared/emptyPageHint.module.css";
import styles from "./music.module.css";

type MusicArtistViewProps = {
  artistId: string;
};

const ARTIST_TRACKS_PAGE_SIZE = 30;

function ArtistPlayIcon() {
  return (
    <svg className={styles.playlistHeroPlayIcon} viewBox="0 0 24 24" aria-hidden>
      <path d="M8.5 5.8v12.4L18 12 8.5 5.8z" fill="currentColor" />
    </svg>
  );
}

function formatArtistTrackCount(count: number): string {
  const n = Math.max(0, Math.floor(count));
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} трек`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return `${n} трека`;
  return `${n} треков`;
}

function artistInitial(name: string): string {
  return name.trim().slice(0, 1).toLocaleUpperCase("ru-RU") || "A";
}

export function MusicArtistView({ artistId }: MusicArtistViewProps) {
  const router = useRouter();
  const { playQueue, sourceId, playing, togglePlay } = useMusicPlayer();
  const playbackSourceId = `artist:${artistId}`;
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [artist, setArtist] = useState<MusicArtistDetailDto | null>(null);
  const [artistCover, setArtistCover] = useState<{ artistUuid: string; url: string } | null>(null);
  const [tracks, setTracks] = useState(() => [] as ReturnType<typeof mapMusicTrackDtoToItem>[]);
  const [page, setPage] = useState(1);
  const [totalCount, setTotalCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      apiGetMusicArtist(artistId),
      apiGetMusicArtistTracks(artistId, 1, ARTIST_TRACKS_PAGE_SIZE),
    ])
      .then(([artistDetail, firstPage]) => {
        if (cancelled) return;
        setArtist(artistDetail);
        setTracks(firstPage.tracks.map(mapMusicTrackDtoToItem));
        setPage(firstPage.page);
        setTotalCount(firstPage.totalCount);
        setLoadError(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setArtist(null);
        setTracks([]);
        setLoadError(error instanceof Error ? error.message : "Не удалось загрузить артиста.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [artistId]);

  useEffect(() => {
    let cancelled = false;

    if (!artist?.hasCoverImage) {
      return () => {
        cancelled = true;
      };
    }

    void apiFetchMusicArtistCoverBlob(artist.artistUuid)
      .then((blob) => {
        if (cancelled) return;
        const nextUrl = URL.createObjectURL(blob);
        setArtistCover((prev) => {
          if (prev) URL.revokeObjectURL(prev.url);
          return { artistUuid: artist.artistUuid, url: nextUrl };
        });
      })
      .catch(() => {
        if (!cancelled) {
          setArtistCover((prev) => {
            if (prev?.artistUuid === artist.artistUuid) URL.revokeObjectURL(prev.url);
            return prev?.artistUuid === artist.artistUuid ? null : prev;
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [artist?.artistUuid, artist?.hasCoverImage]);

  useEffect(() => {
    return () => {
      if (artistCover) URL.revokeObjectURL(artistCover.url);
    };
  }, [artistCover]);

  const handleLoadMore = async () => {
    if (loadingMore || tracks.length >= totalCount) return;
    setLoadingMore(true);
    try {
      const nextPage = await apiGetMusicArtistTracks(artistId, page + 1, ARTIST_TRACKS_PAGE_SIZE);
      setTracks((prev) => [...prev, ...nextPage.tracks.map(mapMusicTrackDtoToItem)]);
      setPage(nextPage.page);
      setTotalCount(nextPage.totalCount);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Не удалось загрузить треки.");
    } finally {
      setLoadingMore(false);
    }
  };

  const handleListen = () => {
    if (tracks.length === 0) return;

    if (sourceId === playbackSourceId) {
      togglePlay();
      return;
    }

    playQueue(mapMusicTrackItemsToPlayerTracks(tracks), 0, { sourceId: playbackSourceId });
  };

  const handleExit = () => {
    router.push("/music", { scroll: false });
  };

  const closeButton = (
    <button
      type="button"
      className={styles.playlistCloseBtn}
      aria-label="Закрыть артиста"
      onClick={handleExit}
    >
      <svg className={styles.playlistCloseBtnIcon} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  );

  if (loading) {
    return (
      <div className={styles.artistPageShell}>
        {closeButton}
        <div className={styles.playlistPage}>
          <p className={`${emptyHintStyles.hint} ${emptyHintStyles.hintCentered}`}>Загрузка…</p>
        </div>
      </div>
    );
  }

  if (loadError || !artist) {
    return (
      <div className={styles.artistPageShell}>
        {closeButton}
        <div className={styles.playlistPage}>
          <p className={`${emptyHintStyles.hint} ${emptyHintStyles.hintCentered}`} role="alert">
            {loadError ?? "Артист не найден."}
          </p>
        </div>
      </div>
    );
  }

  const isArtistPlaying = sourceId === playbackSourceId && playing;
  const hasMore = tracks.length < totalCount;
  const artistCoverUrl = artistCover?.artistUuid === artist.artistUuid ? artistCover.url : null;

  return (
    <div className={styles.artistPageShell}>
      {closeButton}
      <div className={styles.playlistPage}>
        <div className={styles.playlistHero}>
          <div className={`${styles.playlistHeroCover} ${styles.artistHeroCover}`} aria-hidden>
            {artistCoverUrl ? (
              <span
                className={styles.artistHeroCoverImage}
                style={{ backgroundImage: `url("${artistCoverUrl}")` }}
              />
            ) : (
              <span className={styles.artistHeroInitial}>{artistInitial(artist.displayName)}</span>
            )}
          </div>
          <div className={styles.playlistHeroSide}>
            <div className={styles.playlistHeroInfo}>
              <p className={`${styles.playlistHeroKind} flora-type-15`}>Артист</p>
              <h1 className={styles.playlistHeroTitle}>{artist.displayName}</h1>
              {artist.linkedUserUuid ? (
                <Link
                  className={`${styles.artistHeroProfileLink} flora-type-15`}
                  href={`/profile/${encodeURIComponent(artist.linkedUserUuid)}`}
                >
                  Профиль
                </Link>
              ) : null}
              <p className={`${styles.playlistHeroMeta} flora-type-15`}>
                {formatArtistTrackCount(artist.tracksCount || totalCount)}
              </p>
            </div>
            <div className={styles.playlistHeroActions} aria-label="Действия с артистом">
              <button
                type="button"
                className={styles.playlistHeroListenBtn}
                aria-pressed={isArtistPlaying}
                disabled={tracks.length === 0}
                onClick={handleListen}
              >
                <ArtistPlayIcon />
                <span>{isArtistPlaying ? "Пауза" : "Слушать"}</span>
              </button>
            </div>
          </div>
        </div>

        <hr className={styles.playlistDivider} aria-hidden />

        {tracks.length > 0 ? (
          <>
            <MyMusicTracksList
              tracks={tracks}
              onTracksChange={setTracks}
              playbackSourceId={playbackSourceId}
            />
            {hasMore ? (
              <button
                type="button"
                className={`${styles.artistTracksMoreBtn} flora-type-15`}
                disabled={loadingMore}
                onClick={() => void handleLoadMore()}
              >
                {loadingMore ? "Загрузка…" : "Показать ещё"}
              </button>
            ) : null}
          </>
        ) : (
          <p className={`${emptyHintStyles.hint} ${styles.playlistEmptyHint}`}>
            У этого артиста пока нет треков.
          </p>
        )}
      </div>
    </div>
  );
}

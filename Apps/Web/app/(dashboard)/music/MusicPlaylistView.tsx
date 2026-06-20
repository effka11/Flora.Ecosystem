"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useRouter } from "next/navigation";
import { useCurrentUser } from "@/app/_dashboard/CurrentUserContext";
import { profileDisplayName } from "@/app/_dashboard/userDisplay";
import { coverColorIdToColor } from "@/app/(dashboard)/music/musicDefaultCovers";
import { formatPlaylistTrackCount, playlistVariantToClass } from "@/app/(dashboard)/music/musicPlaylists";
import { mapMusicTrackDtoToItem } from "@/app/(dashboard)/music/musicTrackMappers";
import { MyMusicTracksList } from "@/app/(dashboard)/music/MyMusicTracksList";
import { mapMusicTrackItemsToPlayerTracks } from "@/app/(dashboard)/music/player/mapPlayerTrack";
import { useMusicPlayer } from "@/app/(dashboard)/music/player/MusicPlayerProvider";
import { invalidateMusicCaches } from "@/lib/dashboardPreload";
import { apiDeleteMusicPlaylist, apiGetMusicPlaylist } from "@/lib/musicApi";
import emptyHintStyles from "@/app/_shared/emptyPageHint.module.css";
import styles from "./music.module.css";

type MusicPlaylistViewProps = {
  playlistId: string;
};

function PlaylistPlayIcon() {
  return (
    <svg className={styles.playlistHeroPlayIcon} viewBox="0 0 24 24" aria-hidden>
      <path d="M8.5 5.8v12.4L18 12 8.5 5.8z" fill="currentColor" />
    </svg>
  );
}

function PlaylistHeartIcon() {
  return (
    <svg className={styles.playlistHeroActionIcon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 20s-7-4.4-7-10.1A3.9 3.9 0 0 1 12 7.5a3.9 3.9 0 0 1 7 2.4C19 15.6 12 20 12 20z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlaylistDownloadIcon() {
  return (
    <svg className={styles.playlistHeroActionIcon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 4.5v9m0 0 4-4m-4 4-4-4M5.5 18.5h13"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlaylistMoreIcon() {
  return (
    <svg className={styles.playlistHeroActionIcon} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6.5 12h.01M12 12h.01M17.5 12h.01"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function MusicPlaylistView({ playlistId }: MusicPlaylistViewProps) {
  const router = useRouter();
  const { me, loading: meLoading } = useCurrentUser();
  const { playQueue, sourceId, playing, togglePlay } = useMusicPlayer();
  const playbackSourceId = `playlist:${playlistId}`;
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [trackCount, setTrackCount] = useState(0);
  const [variant, setVariant] = useState("user");
  const [coverColorId, setCoverColorId] = useState<string | null>(null);
  const [canDelete, setCanDelete] = useState(false);
  const [tracks, setTracks] = useState(() => [] as ReturnType<typeof mapMusicTrackDtoToItem>[]);
  const [deleteBusy, setDeleteBusy] = useState(false);

  const loadPlaylist = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const playlist = await apiGetMusicPlaylist(playlistId);
      setTitle(playlist.title);
      setTrackCount(playlist.trackCount);
      setVariant(playlist.variant);
      setCoverColorId(playlist.coverColorId);
      setCanDelete(playlist.canDelete);
      setTracks(playlist.tracks.map(mapMusicTrackDtoToItem));
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Не удалось загрузить плейлист.");
      setTracks([]);
    } finally {
      setLoading(false);
    }
  }, [playlistId]);

  useEffect(() => {
    void loadPlaylist();
  }, [loadPlaylist]);

  const authorName = me
    ? profileDisplayName(me.displayName, me.username)
    : meLoading
      ? "…"
      : "Профиль";

  const variantClass = playlistVariantToClass(variant);
  const coverStyle = useMemo(() => {
    if (variant !== "user" || !coverColorId) return undefined;
    return { "--playlist-color": coverColorIdToColor(coverColorId) } as CSSProperties;
  }, [variant, coverColorId]);

  const handleListen = () => {
    if (tracks.length === 0) return;

    if (sourceId === playbackSourceId) {
      togglePlay();
      return;
    }

    playQueue(mapMusicTrackItemsToPlayerTracks(tracks), 0, { sourceId: playbackSourceId });
  };

  const isPlaylistPlaying = sourceId === playbackSourceId && playing;

  const handleExit = () => {
    router.push("/music", { scroll: false });
  };

  const handleDelete = async () => {
    if (!canDelete || deleteBusy) return;
    const confirmed = window.confirm(`Удалить плейлист «${title}»?`);
    if (!confirmed) return;

    setDeleteBusy(true);
    try {
      await apiDeleteMusicPlaylist(playlistId);
      invalidateMusicCaches();
      router.push("/music", { scroll: false });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Не удалось удалить плейлист.");
    } finally {
      setDeleteBusy(false);
    }
  };

  const closeButton = (
    <button
      type="button"
      className={styles.playlistCloseBtn}
      aria-label="Закрыть плейлист"
      onClick={handleExit}
    >
      <svg className={styles.playlistCloseBtnIcon} viewBox="0 0 24 24" fill="none" aria-hidden>
        <path d="M18 6 6 18M6 6l12 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
  );

  if (loading) {
    return (
      <div className={styles.playlistPageShell}>
        {closeButton}
        <div className={styles.playlistPage}>
          <p className={`${emptyHintStyles.hint} ${emptyHintStyles.hintCentered}`}>Загрузка…</p>
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className={styles.playlistPageShell}>
        {closeButton}
        <div className={styles.playlistPage}>
          <p className={`${emptyHintStyles.hint} ${emptyHintStyles.hintCentered}`} role="alert">
            {loadError}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.playlistPageShell}>
      {closeButton}
      <div className={styles.playlistPage}>
      {canDelete ? (
        <div className={styles.playlistPageHeader}>
          <button
            type="button"
            className={styles.playlistDeleteBtn}
            onClick={() => void handleDelete()}
            disabled={deleteBusy}
          >
            {deleteBusy ? "Удаление…" : "Удалить"}
          </button>
        </div>
      ) : null}

      <div className={styles.playlistHero}>
        <div
          className={`${styles.playlistHeroCover} ${styles[variantClass]}`}
          style={coverStyle}
          aria-hidden
        >
          <div className={styles.playlistCardBg} />
        </div>
        <div className={styles.playlistHeroSide}>
          <div className={styles.playlistHeroInfo}>
            <p className={`${styles.playlistHeroKind} flora-type-15`}>Плейлист</p>
            <h1 className={styles.playlistHeroTitle}>{title}</h1>
            <p className={`${styles.playlistHeroAuthor} flora-type-15`}>{authorName}</p>
            <p className={`${styles.playlistHeroMeta} flora-type-15`}>{formatPlaylistTrackCount(trackCount)}</p>
          </div>
          <div className={styles.playlistHeroActions} aria-label="Действия с плейлистом">
            <button
              type="button"
              className={styles.playlistHeroListenBtn}
              aria-pressed={isPlaylistPlaying}
              disabled={tracks.length === 0}
              onClick={handleListen}
            >
              <PlaylistPlayIcon />
              <span>{isPlaylistPlaying ? "Пауза" : "Слушать"}</span>
            </button>
            <button type="button" className={styles.playlistHeroActionBtn} aria-label="Лайкнуть плейлист">
              <PlaylistHeartIcon />
            </button>
            <button type="button" className={styles.playlistHeroActionBtn} aria-label="Скачать плейлист">
              <PlaylistDownloadIcon />
            </button>
            <button type="button" className={styles.playlistHeroActionBtn} aria-label="Ещё">
              <PlaylistMoreIcon />
            </button>
          </div>
        </div>
      </div>

      <hr className={styles.playlistDivider} aria-hidden />

      {tracks.length > 0 ? (
        <MyMusicTracksList
          tracks={tracks}
          onTracksChange={setTracks}
          playbackSourceId={playbackSourceId}
        />
      ) : (
        <p className={`${emptyHintStyles.hint} ${styles.playlistEmptyHint}`}>
          В этом плейлисте пока нет треков.
        </p>
      )}
      </div>
    </div>
  );
}

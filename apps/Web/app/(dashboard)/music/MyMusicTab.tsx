"use client";

import { useCallback, useEffect, useState } from "react";
import { invalidateMusicCaches } from "@/lib/dashboardPreload";
import { loadMusicLibrarySnapshot, peekMusicLibrarySnapshot } from "@/lib/musicLibraryPreload";
import type { PlaylistItem } from "@/app/(dashboard)/music/musicPlaylists";
import type { MusicTrackItem } from "@/app/(dashboard)/music/musicTracks";
import { MyMusicTracksList } from "@/app/(dashboard)/music/MyMusicTracksList";
import { PlaylistsCarousel } from "@/app/(dashboard)/music/PlaylistsCarousel";
import emptyHintStyles from "@/app/_shared/emptyPageHint.module.css";
import styles from "./music.module.css";

type MyMusicTabProps = {
  refreshKey?: number;
  onPlatformTrackDeleted?: () => void;
};

export function MyMusicTab({ refreshKey = 0, onPlatformTrackDeleted }: MyMusicTabProps) {
  const [tracks, setTracks] = useState<MusicTrackItem[]>(() => peekMusicLibrarySnapshot()?.tracks ?? []);
  const [playlists, setPlaylists] = useState<PlaylistItem[]>(() => peekMusicLibrarySnapshot()?.playlists ?? []);
  const [loading, setLoading] = useState(() => peekMusicLibrarySnapshot() === null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadLibrary = useCallback(async (refresh = false) => {
    const cached = !refresh ? peekMusicLibrarySnapshot() : null;
    if (cached) {
      setTracks(cached.tracks);
      setPlaylists(cached.playlists);
      setLoading(false);
    } else {
      setLoading(true);
    }
    setLoadError(null);
    try {
      const snapshot = await loadMusicLibrarySnapshot({ refresh });
      setTracks(snapshot.tracks);
      setPlaylists(snapshot.playlists);
    } catch (error) {
      if (!cached) {
        setTracks([]);
        setPlaylists([]);
      }
      setLoadError(error instanceof Error ? error.message : "Не удалось загрузить библиотеку.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (refreshKey > 0) {
      invalidateMusicCaches();
      void loadLibrary(true);
      return;
    }
    void loadLibrary(false);
  }, [loadLibrary, refreshKey]);

  const handlePlaylistsChange = useCallback((next: PlaylistItem[]) => {
    setPlaylists(next);
  }, []);

  if (loading) {
    return (
      <div className={styles.myMusicEmptyWrap}>
        <p className={`${emptyHintStyles.hint} ${emptyHintStyles.hintCentered}`}>Загрузка…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className={styles.myMusicEmptyWrap}>
        <p className={`${emptyHintStyles.hint} ${emptyHintStyles.hintCentered}`} role="alert">
          {loadError}
        </p>
      </div>
    );
  }

  return (
    <div className={styles.myMusicWrap}>
      <PlaylistsCarousel playlists={playlists} onPlaylistsChange={handlePlaylistsChange} />
      {tracks.length > 0 ? (
        <>
          <hr className={styles.myMusicDivider} aria-hidden />
          <MyMusicTracksList
            tracks={tracks}
            onTracksChange={setTracks}
            onPlatformTrackDeleted={onPlatformTrackDeleted}
          />
        </>
      ) : null}
    </div>
  );
}

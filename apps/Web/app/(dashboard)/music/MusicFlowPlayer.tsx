"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { FlowArt } from "@/app/(dashboard)/music/FlowArt";
import { FlowPlayIcon } from "@/app/(dashboard)/music/FlowPlayIcon";
import { useMusicPlayer } from "@/app/(dashboard)/music/player/MusicPlayerProvider";
import { mapFlowTrackDtosToPlayerTracks } from "@/app/(dashboard)/music/player/mapPlayerTrack";
import type { PlayerTrack } from "@/app/(dashboard)/music/player/playerTypes";
import { apiGetMusicFlowWave } from "@/lib/musicApi";
import styles from "./music.module.css";

const FLOW_WAVE_SIZE = 12;
const FLOW_SOURCE_ID = "flow";

type MusicFlowPlayerProps = {
  genreId?: string;
  subgenreId?: string;
  title?: string;
  subtitle?: string;
  variant?: "default" | "genreMini";
};

export function MusicFlowPlayer({
  genreId,
  subgenreId,
  title = "Мой поток",
  subtitle: subtitleOverride,
  variant = "default",
}: MusicFlowPlayerProps = {}) {
  const { sourceId, currentTrack, playing, busy, error, playQueue, togglePlay } = useMusicPlayer();
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<{ sourceId: string; message: string } | null>(null);

  const playedIdsRef = useRef<Set<string>>(new Set());
  const scopedSourceId = useMemo(() => {
    if (!genreId) return FLOW_SOURCE_ID;
    return subgenreId ? `${FLOW_SOURCE_ID}:genre:${genreId}:subgenre:${subgenreId}` : `${FLOW_SOURCE_ID}:genre:${genreId}`;
  }, [genreId, subgenreId]);
  const playedScopeRef = useRef(scopedSourceId);

  const resetPlayedIdsIfScopeChanged = useCallback(() => {
    if (playedScopeRef.current === scopedSourceId) return;
    playedScopeRef.current = scopedSourceId;
    playedIdsRef.current = new Set();
  }, [scopedSourceId]);

  const loadMore = useCallback(async (): Promise<PlayerTrack[]> => {
    resetPlayedIdsIfScopeChanged();
    const wave = await apiGetMusicFlowWave({
      take: FLOW_WAVE_SIZE,
      excludeTrackUuids: [...playedIdsRef.current],
      genreId,
      subgenreId,
    });

    if (wave.tracks.length === 0 && playedIdsRef.current.size > 0) {
      playedIdsRef.current = new Set();
      const retryWave = await apiGetMusicFlowWave({
        take: FLOW_WAVE_SIZE,
        excludeTrackUuids: [],
        genreId,
        subgenreId,
      });
      const tracks = mapFlowTrackDtosToPlayerTracks(retryWave.tracks);
      for (const track of tracks) {
        playedIdsRef.current.add(track.id);
      }
      return tracks;
    }

    const tracks = mapFlowTrackDtosToPlayerTracks(wave.tracks);
    for (const track of tracks) {
      playedIdsRef.current.add(track.id);
    }
    return tracks;
  }, [genreId, resetPlayedIdsIfScopeChanged, subgenreId]);

  const startFlow = useCallback(async () => {
    resetPlayedIdsIfScopeChanged();
    setStarting(true);
    setStartError(null);
    try {
      const wave = await apiGetMusicFlowWave({
        take: FLOW_WAVE_SIZE,
        excludeTrackUuids: [...playedIdsRef.current],
        genreId,
        subgenreId,
      });
      const tracks = mapFlowTrackDtosToPlayerTracks(wave.tracks);
      if (tracks.length === 0) {
        setStartError({ sourceId: scopedSourceId, message: "Не удалось подобрать волну рекомендаций." });
        return;
      }
      for (const track of tracks) {
        playedIdsRef.current.add(track.id);
      }
      playQueue(tracks, 0, {
        sourceId: scopedSourceId,
        loadMore,
      });
    } catch {
      setStartError({ sourceId: scopedSourceId, message: "Не удалось загрузить волну рекомендаций." });
    } finally {
      setStarting(false);
    }
  }, [genreId, loadMore, playQueue, resetPlayedIdsIfScopeChanged, scopedSourceId, subgenreId]);

  const isFlowActive = sourceId === scopedSourceId && currentTrack != null;
  const flowPlaying = isFlowActive && playing;
  const flowBusy = starting || (isFlowActive && busy);

  const handleToggle = () => {
    if (isFlowActive) {
      togglePlay();
      return;
    }
    void startFlow();
  };

  const subtitle = flowBusy
    ? "Подбираю волну..."
    : (isFlowActive ? error : startError?.sourceId === scopedSourceId ? startError.message : null) ??
      subtitleOverride ??
      (genreId ? "Бесконечный микс внутри жанра" : "Бесконечный микс из публичных треков");

  return (
    <div className={`${styles.flowPlayer} ${variant === "genreMini" ? styles.flowPlayerGenreMini : ""}`}>
      <div className={styles.flowPlayerBg}>
        <FlowArt className={styles.flowPlayerArt} />
      </div>
      <div className={styles.flowPlayerContent}>
        <button
          type="button"
          className={styles.flowPlayerBtn}
          data-playing={flowPlaying ? "" : undefined}
          aria-label={flowPlaying ? "Пауза" : "Слушать Мой поток"}
          aria-pressed={flowPlaying}
          disabled={flowBusy}
          onClick={handleToggle}
        >
          <FlowPlayIcon className={styles.flowPlayerBtnIcon} playing={flowPlaying} />
        </button>
        <div className={styles.flowPlayerInfo}>
          <h2 className={styles.flowPlayerTitle}>{title}</h2>
          <p className={`${styles.flowPlayerSubtitle} flora-type-15`}>{subtitle}</p>
        </div>
      </div>
    </div>
  );
}

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { MusicPlayerContextValue, PlayQueueOptions, PlayerTrack } from "./playerTypes";
import {
  formatPlaybackError,
  normalizeAudioBlob,
  waitForAudioElementReady,
} from "./playbackAudio";

const PREV_SEEK_THRESHOLD_SEC = 3;

const MusicPlayerContext = createContext<MusicPlayerContextValue | null>(null);

export function useMusicPlayer(): MusicPlayerContextValue {
  const ctx = useContext(MusicPlayerContext);
  if (!ctx) {
    throw new Error("useMusicPlayer must be used within MusicPlayerProvider");
  }
  return ctx;
}

export function MusicPlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const coverUrlRef = useRef<string | null>(null);
  const queueRef = useRef<PlayerTrack[]>([]);
  const indexRef = useRef(-1);
  const loadMoreRef = useRef<(() => Promise<PlayerTrack[]>) | undefined>(undefined);
  const sourceIdRef = useRef<string | null>(null);
  const playEpochRef = useRef(0);
  const loadMoreInFlightRef = useRef(false);
  const nextRef = useRef<() => void>(() => undefined);

  const [queue, setQueue] = useState<PlayerTrack[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [currentTrack, setCurrentTrack] = useState<PlayerTrack | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [hasLoadMore, setHasLoadMore] = useState(false);
  const [playbackSession, setPlaybackSession] = useState(0);

  const syncQueue = useCallback((nextQueue: PlayerTrack[], nextIndex: number) => {
    queueRef.current = nextQueue;
    indexRef.current = nextIndex;
    setQueue(nextQueue);
    setCurrentIndex(nextIndex);
  }, []);

  const revokeAudioUrl = useCallback(() => {
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }, []);

  const revokeCoverUrl = useCallback(() => {
    if (coverUrlRef.current) {
      URL.revokeObjectURL(coverUrlRef.current);
      coverUrlRef.current = null;
    }
    setCoverUrl(null);
  }, []);

  const cleanupAudio = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }
    audioRef.current = null;
    revokeAudioUrl();
    setCurrentTime(0);
    setDuration(0);
  }, [revokeAudioUrl]);

  const stop = useCallback(() => {
    playEpochRef.current += 1;
    loadMoreInFlightRef.current = false;
    cleanupAudio();
    revokeCoverUrl();
    queueRef.current = [];
    indexRef.current = -1;
    loadMoreRef.current = undefined;
    sourceIdRef.current = null;
    setQueue([]);
    setCurrentIndex(-1);
    setCurrentTrack(null);
    setSourceId(null);
    setPlaying(false);
    setBusy(false);
    setError(null);
    setHasLoadMore(false);
    setPlaybackSession(0);
  }, [cleanupAudio, revokeCoverUrl]);

  const loadCoverForTrack = useCallback(
    async (track: PlayerTrack, epoch: number) => {
      revokeCoverUrl();
      if (!track.loadCover) return;

      try {
        const blob = await track.loadCover();
        if (epoch !== playEpochRef.current) {
          return;
        }
        const url = URL.createObjectURL(blob);
        coverUrlRef.current = url;
        setCoverUrl(url);
      } catch {
        // Fallback cover remains visible.
      }
    },
    [revokeCoverUrl],
  );

  const playTrack = useCallback(
    async (track: PlayerTrack, nextQueue: PlayerTrack[], nextIndex: number) => {
      const epoch = ++playEpochRef.current;
      setPlaying(false);
      cleanupAudio();
      revokeCoverUrl();
      syncQueue(nextQueue, nextIndex);
      setCurrentTrack(track);
      setBusy(true);
      setError(null);

      try {
        const blob = await normalizeAudioBlob(await track.loadAudio());
        if (epoch !== playEpochRef.current) {
          return;
        }

        const url = URL.createObjectURL(blob);
        audioUrlRef.current = url;

        const audio = new Audio(url);
        audioRef.current = audio;
        audio.addEventListener("ended", () => nextRef.current(), { once: true });

        await waitForAudioElementReady(audio);
        if (epoch !== playEpochRef.current) {
          audio.pause();
          revokeAudioUrl();
          audioRef.current = null;
          return;
        }

        await audio.play();
        if (epoch !== playEpochRef.current) {
          audio.pause();
          revokeAudioUrl();
          audioRef.current = null;
          return;
        }

        setPlaying(true);
        setPlaybackSession((session) => session + 1);
        void loadCoverForTrack(track, epoch);
      } catch (error) {
        if (epoch !== playEpochRef.current) return;
        cleanupAudio();
        setPlaying(false);
        setError(formatPlaybackError(error));
      } finally {
        if (epoch === playEpochRef.current) {
          setBusy(false);
        }
      }
    },
    [cleanupAudio, loadCoverForTrack, revokeAudioUrl, revokeCoverUrl, syncQueue],
  );

  const playAt = useCallback(
    async (nextQueue: PlayerTrack[], nextIndex: number) => {
      const track = nextQueue[nextIndex];
      if (!track) {
        stop();
        return;
      }
      await playTrack(track, nextQueue, nextIndex);
    },
    [playTrack, stop],
  );

  const appendFromLoadMore = useCallback(async (): Promise<boolean> => {
    const loadMore = loadMoreRef.current;
    if (!loadMore || loadMoreInFlightRef.current) return false;

    loadMoreInFlightRef.current = true;
    setBusy(true);
    setError(null);

    try {
      const moreTracks = await loadMore();
      if (moreTracks.length === 0) {
        return false;
      }

      const merged = [...queueRef.current, ...moreTracks];
      const nextIndex = queueRef.current.length;
      await playAt(merged, nextIndex);
      return true;
    } catch {
      setError("Не удалось загрузить следующие треки.");
      return false;
    } finally {
      loadMoreInFlightRef.current = false;
      setBusy(false);
    }
  }, [playAt]);

  const playNext = useCallback(async () => {
    const existingQueue = queueRef.current;
    const nextIndex = indexRef.current + 1;

    if (existingQueue[nextIndex]) {
      await playAt(existingQueue, nextIndex);
      return;
    }

    if (loadMoreRef.current) {
      const started = await appendFromLoadMore();
      if (!started) {
        stop();
      }
      return;
    }

    stop();
  }, [appendFromLoadMore, playAt, stop]);

  useEffect(() => {
    nextRef.current = () => {
      void playNext();
    };
  }, [playNext]);

  const playPrevious = useCallback(async () => {
    const audio = audioRef.current;
    if (audio && audio.currentTime > PREV_SEEK_THRESHOLD_SEC) {
      audio.currentTime = 0;
      setCurrentTime(0);
      return;
    }

    const existingQueue = queueRef.current;
    const prevIndex = indexRef.current - 1;

    if (prevIndex < 0 || !existingQueue[prevIndex]) {
      if (audio) {
        audio.currentTime = 0;
        setCurrentTime(0);
      }
      return;
    }

    await playAt(existingQueue, prevIndex);
  }, [playAt]);

  const playQueue = useCallback(
    (tracks: PlayerTrack[], startIndex: number, options: PlayQueueOptions) => {
      if (tracks.length === 0) return;

      const safeIndex = Math.min(Math.max(0, startIndex), tracks.length - 1);
      loadMoreInFlightRef.current = false;
      loadMoreRef.current = options.loadMore;
      sourceIdRef.current = options.sourceId;
      setSourceId(options.sourceId);
      setHasLoadMore(options.loadMore != null);
      void playAt(tracks, safeIndex);
    },
    [playAt],
  );

  const togglePlay = useCallback(() => {
    if (error && currentTrack) {
      const queueSnapshot = queueRef.current;
      const indexSnapshot = indexRef.current;
      void playAt(queueSnapshot, indexSnapshot);
      return;
    }

    const audio = audioRef.current;
    if (!audio || !currentTrack) return;

    if (playing) {
      audio.pause();
      setPlaying(false);
      return;
    }

    void audio.play().then(
      () => setPlaying(true),
      () => setPlaying(false),
    );
  }, [currentTrack, error, playAt, playing]);

  const seekTo = useCallback(
    (seconds: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      const maxDuration =
        duration > 0
          ? duration
          : Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration
            : currentTrack?.durationSeconds ?? 0;
      if (maxDuration <= 0) return;
      const clamped = Math.min(Math.max(0, seconds), maxDuration);
      audio.currentTime = clamped;
      setCurrentTime(clamped);
    },
    [currentTrack?.durationSeconds, duration],
  );

  const seekByClientX = useCallback(
    (clientX: number, trackEl: HTMLDivElement) => {
      const audio = audioRef.current;
      const maxDuration =
        duration > 0
          ? duration
          : audio && Number.isFinite(audio.duration) && audio.duration > 0
            ? audio.duration
            : currentTrack?.durationSeconds ?? 0;
      if (maxDuration <= 0) return;
      const rect = trackEl.getBoundingClientRect();
      if (rect.width <= 0) return;
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      seekTo(ratio * maxDuration);
    },
    [currentTrack?.durationSeconds, duration, seekTo],
  );

  useEffect(() => {
    return () => {
      playEpochRef.current += 1;
      cleanupAudio();
      revokeCoverUrl();
    };
  }, [cleanupAudio, revokeCoverUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !currentTrack || playbackSession === 0) {
      if (!currentTrack) {
        setCurrentTime(0);
        setDuration(0);
      }
      return;
    }

    const syncDuration = () => {
      const fromAudio = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      setDuration(fromAudio > 0 ? fromAudio : currentTrack.durationSeconds);
    };
    const onTimeUpdate = () => {
      setCurrentTime(audio.currentTime);
    };

    syncDuration();
    setCurrentTime(audio.currentTime);
    audio.addEventListener("loadedmetadata", syncDuration);
    audio.addEventListener("durationchange", syncDuration);
    audio.addEventListener("timeupdate", onTimeUpdate);

    return () => {
      audio.removeEventListener("loadedmetadata", syncDuration);
      audio.removeEventListener("durationchange", syncDuration);
      audio.removeEventListener("timeupdate", onTimeUpdate);
    };
  }, [currentTrack, playbackSession]);

  const canPlayNext = useMemo(() => {
    if (queue.length === 0 || currentIndex < 0) return false;
    if (currentIndex < queue.length - 1) return true;
    return hasLoadMore;
  }, [currentIndex, hasLoadMore, queue.length]);

  const isTrackActive = useCallback(
    (trackId: string) => currentTrack?.id === trackId,
    [currentTrack],
  );

  const isTrackPlaying = useCallback(
    (trackId: string) => currentTrack?.id === trackId && playing,
    [currentTrack, playing],
  );

  const value = useMemo<MusicPlayerContextValue>(
    () => ({
      queue,
      currentIndex,
      currentTrack,
      sourceId,
      playing,
      busy,
      error,
      currentTime,
      duration,
      coverUrl,
      canPlayNext,
      playQueue,
      togglePlay,
      playNext,
      playPrevious,
      seekTo,
      seekByClientX,
      stop,
      isTrackActive,
      isTrackPlaying,
    }),
    [
      busy,
      canPlayNext,
      coverUrl,
      currentIndex,
      currentTime,
      currentTrack,
      duration,
      error,
      isTrackActive,
      isTrackPlaying,
      playNext,
      playPrevious,
      playQueue,
      playing,
      queue,
      seekByClientX,
      seekTo,
      sourceId,
      stop,
      togglePlay,
    ],
  );

  return <MusicPlayerContext.Provider value={value}>{children}</MusicPlayerContext.Provider>;
}

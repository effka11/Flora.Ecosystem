import { create } from "zustand";
import { apiGetMusicTrackAudioUrl, apiGetMusicTrackCoverUrl } from "@flora/client-core/api";

export type PlayerTrack = {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  coverColor: string;
  hasCoverImage: boolean;
};

type LoadMoreTracks = () => Promise<PlayerTrack[]>;

type MusicState = {
  queue: PlayerTrack[];
  current: PlayerTrack | null;
  currentIndex: number;
  playing: boolean;
  sourceId: string | null;
  positionMs: number;
  durationMs: number;
  seekRequestMs: number | null;
  loadMore: LoadMoreTracks | null;
  playQueue: (
    tracks: PlayerTrack[],
    startIndex?: number,
    options?: { sourceId?: string; loadMore?: LoadMoreTracks | null },
  ) => void;
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  next: () => Promise<void>;
  prev: () => void;
  stop: () => void;
  seek: (positionMs: number) => void;
  consumeSeekRequest: () => number | null;
  setPlaybackProgress: (positionMs: number, durationMs: number) => void;
  streamUrl: (trackUuid: string) => Promise<string>;
  coverUrl: (trackUuid: string) => string;
};

export const useMusicStore = create<MusicState>((set, get) => ({
  queue: [],
  current: null,
  currentIndex: -1,
  playing: false,
  sourceId: null,
  positionMs: 0,
  durationMs: 0,
  seekRequestMs: null,
  loadMore: null,
  playQueue(tracks, startIndex = 0, options) {
    const currentIndex = tracks[startIndex] ? startIndex : -1;
    set({
      queue: tracks,
      current: tracks[startIndex] ?? null,
      currentIndex,
      playing: currentIndex >= 0,
      sourceId: options?.sourceId ?? null,
      loadMore: options?.loadMore ?? null,
      positionMs: 0,
      durationMs: tracks[startIndex]?.durationMs ?? 0,
      seekRequestMs: null,
    });
  },
  play() {
    if (get().current) set({ playing: true });
  },
  pause() {
    set({ playing: false });
  },
  togglePlay() {
    const { current, playing } = get();
    if (!current) return;
    set({ playing: !playing });
  },
  async next() {
    const { queue, currentIndex, loadMore } = get();
    const nextIndex = currentIndex + 1;
    if (queue[nextIndex]) {
      set({
        current: queue[nextIndex],
        currentIndex: nextIndex,
        playing: true,
        positionMs: 0,
        durationMs: queue[nextIndex].durationMs,
        seekRequestMs: null,
      });
      return;
    }

    if (!loadMore) {
      set({ current: null, currentIndex: -1, playing: false, positionMs: 0, durationMs: 0 });
      return;
    }

    const more = await loadMore();
    if (more.length === 0) {
      set({ playing: false });
      return;
    }

    const merged = [...queue, ...more];
    set({
      queue: merged,
      current: merged[nextIndex] ?? null,
      currentIndex: merged[nextIndex] ? nextIndex : -1,
      playing: !!merged[nextIndex],
      positionMs: 0,
      durationMs: merged[nextIndex]?.durationMs ?? 0,
      seekRequestMs: null,
    });
  },
  prev() {
    const { queue, currentIndex, positionMs } = get();
    if (positionMs > 3000 || currentIndex <= 0) {
      set({ positionMs: 0, seekRequestMs: 0 });
      return;
    }
    const prevIndex = currentIndex - 1;
    set({
      current: queue[prevIndex] ?? null,
      currentIndex: prevIndex,
      playing: !!queue[prevIndex],
      positionMs: 0,
      durationMs: queue[prevIndex]?.durationMs ?? 0,
      seekRequestMs: null,
    });
  },
  stop() {
    set({
      queue: [],
      current: null,
      currentIndex: -1,
      playing: false,
      sourceId: null,
      positionMs: 0,
      durationMs: 0,
      seekRequestMs: null,
      loadMore: null,
    });
  },
  seek(positionMs) {
    const next = Math.max(0, Math.round(positionMs));
    set({ positionMs: next, seekRequestMs: next });
  },
  consumeSeekRequest() {
    const value = get().seekRequestMs;
    set({ seekRequestMs: null });
    return value;
  },
  setPlaybackProgress(positionMs, durationMs) {
    set({
      positionMs: Math.max(0, Math.round(positionMs)),
      durationMs: Math.max(0, Math.round(durationMs)),
    });
  },
  async streamUrl(trackUuid) {
    return apiGetMusicTrackAudioUrl(trackUuid);
  },
  coverUrl(trackUuid) {
    return apiGetMusicTrackCoverUrl(trackUuid);
  },
}));

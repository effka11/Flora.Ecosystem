import type { MusicTrackKindId } from "@/app/(dashboard)/music/musicTrackKinds";
import type { TrackArtistCredit } from "@/lib/musicApi";

export type PlayerTrack = {
  id: string;
  title: string;
  artist: string;
  artistCredits: TrackArtistCredit[];
  durationSeconds: number;
  coverColor?: string;
  trackKindId?: MusicTrackKindId;
  loadAudio: () => Promise<Blob>;
  loadCover?: () => Promise<Blob>;
};

export type PlayQueueOptions = {
  sourceId: string;
  loadMore?: () => Promise<PlayerTrack[]>;
};

export type MusicPlayerContextValue = {
  queue: PlayerTrack[];
  currentIndex: number;
  currentTrack: PlayerTrack | null;
  sourceId: string | null;
  playing: boolean;
  busy: boolean;
  error: string | null;
  currentTime: number;
  duration: number;
  coverUrl: string | null;
  canPlayNext: boolean;
  playQueue: (tracks: PlayerTrack[], startIndex: number, options: PlayQueueOptions) => void;
  togglePlay: () => void;
  playNext: () => void;
  playPrevious: () => void;
  seekTo: (seconds: number) => void;
  seekByClientX: (clientX: number, trackEl: HTMLDivElement) => void;
  stop: () => void;
  isTrackActive: (trackId: string) => boolean;
  isTrackPlaying: (trackId: string) => boolean;
};

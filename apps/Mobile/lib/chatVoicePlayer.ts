/**
 * Imperative shared chat-voice player (no React effect ownership).
 */
import { createAudioPlayer, type AudioPlayer } from "expo-audio";
import { File } from "expo-file-system";
import { Platform } from "react-native";
import {
  ensureVoicePlaybackAudioMode,
  normalizePlayableAudioUri,
} from "@/lib/voicePlaybackAudio";
import { useMusicStore } from "@/stores/musicStore";

type Listener = () => void;

export type ChatVoiceSession = {
  activeId: string | null;
  uri: string | null;
  shouldPlay: boolean;
  token: number;
  playing: boolean;
  error: string | null;
};

let session: ChatVoiceSession = {
  activeId: null,
  uri: null,
  shouldPlay: false,
  token: 0,
  playing: false,
  error: null,
};

let player: AudioPlayer | null = null;
let playGeneration = 0;
let watchTimer: ReturnType<typeof setInterval> | null = null;

const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setSession(patch: Partial<ChatVoiceSession>): void {
  session = { ...session, ...patch };
  emit();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopWatch(): void {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}

function releasePlayer(): void {
  stopWatch();
  if (!player) return;
  try {
    player.pause();
  } catch {
    /* ignore */
  }
  try {
    // SharedObject.release — remove() is not always present on older builds.
    const releasable = player as AudioPlayer & { remove?: () => void; release?: () => void };
    if (typeof releasable.remove === "function") releasable.remove();
    else if (typeof releasable.release === "function") releasable.release();
  } catch {
    /* ignore */
  }
  player = null;
}

function finishPlaybackSession(): void {
  stopWatch();
  // Pause BEFORE seek — otherwise playWhenReady stays true and seekTo(0)
  // immediately replays the whole message once more.
  try {
    player?.pause();
  } catch {
    /* ignore */
  }
  try {
    void player?.seekTo(0);
  } catch {
    /* ignore */
  }
  setSession({
    shouldPlay: false,
    playing: false,
    activeId: null,
    error: null,
  });
}

function startWatch(gen: number, playerId: string): void {
  stopWatch();
  let sawPlaying = false;
  let stoppedTicks = 0;
  watchTimer = setInterval(() => {
    if (gen !== playGeneration || !player) {
      stopWatch();
      return;
    }
    const status = player.currentStatus;
    const playing = Boolean(player.playing || status.playing);
    if (playing) {
      sawPlaying = true;
      stoppedTicks = 0;
    } else if (sawPlaying) {
      stoppedTicks += 1;
    }
    if (session.playing !== playing) {
      setSession({ playing });
    }
    // didJustFinish is flaky on Android local files — also treat sustained stop as end.
    if (status.didJustFinish || (sawPlaying && !playing && stoppedTicks >= 2)) {
      finishPlaybackSession();
      return;
    }
    if (status.error && session.activeId === playerId) {
      stopWatch();
      setSession({
        error: status.error,
        shouldPlay: false,
        playing: false,
      });
    }
  }, 200);
}

function resolvePlayableUri(uri: string): string {
  const normalized = normalizePlayableAudioUri(uri);
  if (Platform.OS !== "android") return normalized;
  try {
    const file = new File(normalized);
    const contentUri = (file as { contentUri?: string }).contentUri;
    if (typeof contentUri === "string" && contentUri.length > 0) {
      return contentUri;
    }
  } catch {
    /* fall through */
  }
  return normalized;
}

async function waitUntilReady(p: AudioPlayer, gen: number, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (gen !== playGeneration) throw new Error("cancelled");
    const status = p.currentStatus;
    if (status.error) throw new Error(status.error);
    if (status.isLoaded || p.isLoaded || (p.duration ?? 0) > 0) return;
    await sleep(40);
  }
  throw new Error(p.currentStatus.error || "Аудио не загрузилось");
}

export function subscribeChatVoicePlayer(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getChatVoiceSession(): ChatVoiceSession {
  return session;
}

export function isChatVoicePlaying(playerId: string): boolean {
  return session.activeId === playerId && session.playing;
}

export function pauseChatVoicePlayback(): void {
  playGeneration += 1;
  stopWatch();
  try {
    player?.pause();
  } catch {
    /* ignore */
  }
  setSession({
    shouldPlay: false,
    playing: false,
    activeId: null,
    error: null,
  });
}

export async function toggleChatVoicePlayback(
  playerId: string,
  uri: string,
): Promise<void> {
  if (!uri.trim()) throw new Error("Пустой URI голосового");

  if (session.activeId === playerId && session.playing) {
    pauseChatVoicePlayback();
    return;
  }
  // Ignore double-tap while the same bubble is still starting.
  if (session.activeId === playerId && session.shouldPlay) {
    return;
  }

  try {
    const music = useMusicStore.getState();
    if (music.playing && typeof music.togglePlay === "function") {
      music.togglePlay();
    }
  } catch {
    /* music store optional */
  }

  await ensureVoicePlaybackAudioMode();

  const playable = resolvePlayableUri(uri.trim());
  const gen = ++playGeneration;

  setSession({
    activeId: playerId,
    uri: playable,
    shouldPlay: true,
    token: session.token + 1,
    playing: false,
    error: null,
  });

  try {
    if (typeof createAudioPlayer !== "function") {
      throw new Error("createAudioPlayer недоступен — пересоберите dev client");
    }

    releasePlayer();
    player = createAudioPlayer(playable, {
      updateInterval: 200,
      keepAudioSessionActive: true,
    });

    await waitUntilReady(player, gen);
    if (gen !== playGeneration) return;

    player.volume = 1;
    player.play();

    for (let i = 0; i < 25; i++) {
      if (gen !== playGeneration) return;
      if (player.playing || player.currentStatus.playing) break;
      if (player.currentStatus.error) {
        throw new Error(player.currentStatus.error);
      }
      await sleep(40);
    }
    if (gen !== playGeneration) return;

    const playing = Boolean(player.playing || player.currentStatus.playing);
    if (!playing && !(player.isLoaded || player.currentStatus.isLoaded)) {
      throw new Error(player.currentStatus.error || "Плеер не запустил воспроизведение");
    }

    setSession({ playing: true, shouldPlay: true, error: null });
    startWatch(gen, playerId);
  } catch (err) {
    if (gen !== playGeneration) return;
    const message = err instanceof Error ? err.message : "Не удалось воспроизвести";
    if (message === "cancelled") return;
    releasePlayer();
    setSession({
      error: message,
      shouldPlay: false,
      playing: false,
    });
    throw err instanceof Error ? err : new Error(message);
  }
}

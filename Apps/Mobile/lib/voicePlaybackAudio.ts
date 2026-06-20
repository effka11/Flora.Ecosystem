import { setAudioModeAsync, type AudioPlayer } from "expo-audio";

export async function ensureVoicePlaybackAudioMode(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: false,
    playsInSilentMode: true,
  });
}

export async function ensureVoiceRecordingAudioMode(): Promise<void> {
  await setAudioModeAsync({
    allowsRecording: true,
    playsInSilentMode: true,
  });
}

/** Загрузить uri в плеер и дать нативному слою подготовить источник перед play. */
export async function replaceVoiceSourceAndPlay(player: AudioPlayer, uri: string): Promise<void> {
  player.replace({ uri });
  await new Promise((resolve) => setTimeout(resolve, 100));
  player.play();
}

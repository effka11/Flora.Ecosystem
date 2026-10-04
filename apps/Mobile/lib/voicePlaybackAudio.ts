import { setAudioModeAsync } from "expo-audio";

/**
 * Do not call setIsAudioActiveAsync — older Flora dev clients ship expo-audio
 * without that native method; the JS wrapper then throws
 * "undefined is not a function" and aborts voice play before Alert.
 */
export async function ensureVoicePlaybackAudioMode(): Promise<void> {
  try {
    await setAudioModeAsync({
      allowsRecording: false,
      playsInSilentMode: true,
      interruptionMode: "mixWithOthers",
    });
  } catch (err) {
    console.warn("[chat-voice] setAudioModeAsync(playback) failed", err);
  }
}

export async function ensureVoiceRecordingAudioMode(): Promise<void> {
  try {
    await setAudioModeAsync({
      allowsRecording: true,
      playsInSilentMode: true,
      interruptionMode: "doNotMix",
    });
  } catch (err) {
    console.warn("[chat-voice] setAudioModeAsync(recording) failed", err);
  }
}

/** Bare filesystem paths must be `file://` or Android treats them as raw resources. */
export function normalizePlayableAudioUri(uri: string): string {
  const t = uri.trim();
  if (!t) return t;
  if (t.startsWith("file:")) {
    return t.replace(/^file:\/+/i, "file:///");
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
  if (t.startsWith("/")) return `file://${t}`;
  return t;
}

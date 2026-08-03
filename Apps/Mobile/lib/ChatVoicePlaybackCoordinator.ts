import { pauseChatVoicePlayback } from "@/lib/chatVoicePlayer";

/** Stop shared chat-voice playback (navigate away, open another media, etc.). */
export function stopActiveVoicePlayback(): void {
  pauseChatVoicePlayback();
}

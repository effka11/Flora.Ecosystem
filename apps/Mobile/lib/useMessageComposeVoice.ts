import { useCallback, useRef, useState } from "react";
import type { RecordedVoiceDraft } from "@/lib/useVoiceRecorder";
import { VOICE_MAX_DURATION_MS, VOICE_MAX_UPLOAD_BYTES } from "@/lib/voiceLimits";
import { File } from "expo-file-system";

export type ComposeMode = "text" | "voice";

export type VoiceDraft = RecordedVoiceDraft & {
  id: string;
  transcodedUri?: string;
  transcodedContentType?: string;
  transcoding: boolean;
  transcodeError: string | null;
};

function newDraftId(): string {
  return `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function useMessageComposeVoice() {
  const [mode, setMode] = useState<ComposeMode>("text");
  const [draft, setDraft] = useState<VoiceDraft | null>(null);
  const draftRef = useRef<VoiceDraft | null>(null);
  draftRef.current = draft;

  const clearDraft = useCallback(() => {
    setDraft(null);
    setMode("text");
  }, []);

  const setVoiceFromRecording = useCallback((recorded: RecordedVoiceDraft) => {
    void (async () => {
      try {
        const source = new File(recorded.uri);
        const bytes = source.size ?? 0;
        if (recorded.durationMs > VOICE_MAX_DURATION_MS) {
          throw new Error("Голосовое слишком длинное (макс. 30 мин).");
        }
        if (bytes <= 0) {
          throw new Error("Запись пуста.");
        }
        if (bytes > VOICE_MAX_UPLOAD_BYTES) {
          throw new Error("Голосовое слишком большое для отправки.");
        }

        setDraft({
          ...recorded,
          id: newDraftId(),
          transcoding: false,
          transcodeError: null,
        });
        setMode("voice");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Не удалось обработать запись.";
        setDraft({
          ...recorded,
          id: newDraftId(),
          transcoding: false,
          transcodeError: message,
        });
        setMode("voice");
      }
    })();
  }, []);

  const enterVoiceMode = useCallback(() => {
    setMode("voice");
  }, []);

  const exitVoiceMode = useCallback(() => {
    clearDraft();
  }, [clearDraft]);

  const canSendVoice = draft !== null && !draft.transcoding && !draft.transcodeError;

  return {
    mode,
    draft,
    canSendVoice,
    setVoiceFromRecording,
    enterVoiceMode,
    exitVoiceMode,
    clearDraft,
    setMode,
  };
}

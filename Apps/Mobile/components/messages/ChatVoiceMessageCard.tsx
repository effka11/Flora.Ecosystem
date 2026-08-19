import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, View, type GestureResponderEvent } from "react-native";
import { TouchableOpacity } from "react-native-gesture-handler";
import type { FscpVoiceBlock } from "@flora/client-core/fscp";
import { TIME_INLINE_GAP_PX } from "@flora/client-core/display";
import {
  getChatVoiceSession,
  isChatVoicePlaying,
  subscribeChatVoicePlayer,
  toggleChatVoicePlayback,
} from "@/lib/chatVoicePlayer";
import { ensureMessageVoiceUri, peekMessageVoiceUri } from "@/lib/messageVoiceAssets";
import { peekPendingVoiceUri } from "@/lib/pendingVoiceOutgoing";
import { ChatVoiceWaveform } from "@/components/messages/ChatVoiceWaveform";
import { floraColors, floraMessages, floraSpacing } from "@/lib/theme";
import { formatVoiceDuration } from "@/lib/voiceWaveform";

type Props = {
  voiceBlock?: FscpVoiceBlock;
  durationMs: number;
  waveform: number[];
  isFromMe: boolean;
  localUri?: string | null;
  /** Long-press opens bubble menu. */
  onMenuLongPress?: (event?: GestureResponderEvent) => void;
  /** Send time on the duration row (same relation as text time ↔ last line). */
  timeSlot?: ReactNode;
};

export function ChatVoiceMessageCard({
  voiceBlock,
  durationMs,
  waveform,
  isFromMe,
  localUri,
  onMenuLongPress,
  timeSlot,
}: Props) {
  const playerId = voiceBlock?.assetUuid ?? localUri ?? "local-voice";
  const [sourceUri, setSourceUri] = useState<string | null>(
    () =>
      localUri ??
      (voiceBlock
        ? (peekPendingVoiceUri(voiceBlock.assetUuid) ?? peekMessageVoiceUri(voiceBlock.assetUuid))
        : null),
  );
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const playing = useSyncExternalStore(
    subscribeChatVoicePlayer,
    () => isChatVoicePlaying(playerId),
    () => false,
  );

  const sessionError = useSyncExternalStore(
    subscribeChatVoicePlayer,
    () => {
      const s = getChatVoiceSession();
      return s.activeId === playerId ? s.error : null;
    },
    () => null,
  );

  useEffect(() => {
    if (localUri) {
      setSourceUri(localUri);
      return;
    }
    if (!voiceBlock) return;
    const pending = peekPendingVoiceUri(voiceBlock.assetUuid);
    const cached = peekMessageVoiceUri(voiceBlock.assetUuid);
    if (pending) setSourceUri(pending);
    else if (cached) setSourceUri(cached);
  }, [localUri, voiceBlock]);

  const ensureSource = useCallback(async () => {
    if (localUri) return localUri;
    if (!voiceBlock) return sourceUri;
    setLoading(true);
    setLocalError(null);
    try {
      const uri = await ensureMessageVoiceUri(voiceBlock);
      setSourceUri(uri);
      return uri;
    } catch (err) {
      const message =
        err instanceof Error && err.message.trim()
          ? err.message
          : "Не удалось загрузить";
      setLocalError(message);
      Alert.alert("Голосовое", message);
      return null;
    } finally {
      setLoading(false);
    }
  }, [localUri, sourceUri, voiceBlock]);

  const toggle = useCallback(async () => {
    try {
      const uri = await ensureSource();
      if (!uri) return;
      setLocalError(null);
      await toggleChatVoicePlayback(playerId, uri);
      setSourceUri(uri);
    } catch (err) {
      const message =
        err instanceof Error && err.message.trim()
          ? err.message
          : "Не удалось воспроизвести";
      setLocalError(message);
      Alert.alert("Голосовое", message);
    }
  }, [ensureSource, playerId]);

  const error = localError ?? sessionError;
  // Spinner only while downloading/decrypting — not after playback ends
  // (shouldPlay && !playing used to look like "starting" forever).
  const label = error ?? (loading ? "Загрузка…" : formatVoiceDuration(durationMs));
  const playIconColor = floraColors.greenDark;

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={playing ? "Пауза" : "Воспроизвести голосовое"}
      activeOpacity={0.85}
      style={styles.card}
      onPress={() => void toggle()}
      onLongPress={onMenuLongPress}
      delayLongPress={280}
      disabled={loading}
    >
      <View
        style={[styles.playBtn, isFromMe ? styles.playBtnMe : styles.playBtnThem]}
        pointerEvents="none"
      >
        {loading ? (
          <ActivityIndicator size="small" color={playIconColor} />
        ) : (
          <Ionicons
            name={playing ? "pause" : "play"}
            size={18}
            color={playIconColor}
          />
        )}
      </View>
      <View style={styles.body} pointerEvents="none">
        <ChatVoiceWaveform levels={waveform} isFromMe={isFromMe} />
        <View style={styles.durationRow}>
          <Text style={[styles.duration, isFromMe ? styles.durationMe : styles.durationThem]}>
            {label}
          </Text>
          {timeSlot ? <View style={styles.sendTimeSlot}>{timeSlot}</View> : null}
        </View>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
    width: "100%",
    backgroundColor: "transparent",
  },
  playBtn: {
    width: floraMessages.voicePlayBtnSize,
    height: floraMessages.voicePlayBtnSize,
    borderRadius: floraMessages.voicePlayBtnSize / 2,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  playBtnMe: {
    backgroundColor: floraColors.whiteTemplate,
  },
  playBtnThem: {
    backgroundColor: floraColors.greenLight,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  durationRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: TIME_INLINE_GAP_PX,
    minWidth: 0,
    width: "100%",
    height: floraSpacing.grid,
  },
  duration: {
    fontSize: floraMessages.bubbleTimeFontSize,
    includeFontPadding: false,
    letterSpacing: 0.36,
    lineHeight: floraSpacing.grid,
    flexShrink: 1,
  },
  durationMe: {
    color: "rgba(242, 244, 246, 0.78)",
  },
  durationThem: {
    color: "rgba(143, 143, 143, 0.85)",
  },
  sendTimeSlot: {
    flexShrink: 0,
    marginLeft: "auto",
  },
});

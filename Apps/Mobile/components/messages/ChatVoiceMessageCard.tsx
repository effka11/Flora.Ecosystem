import { Ionicons } from "@expo/vector-icons";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { FscpVoiceBlock } from "@flora/client-core/fscp";
import {
  releaseVoicePlayback,
  requestVoicePlayback,
} from "@/lib/ChatVoicePlaybackCoordinator";
import { ensureMessageVoiceUri, peekMessageVoiceUri } from "@/lib/messageVoiceAssets";
import { peekPendingVoiceUri } from "@/lib/pendingVoiceOutgoing";
import { ChatVoiceWaveform } from "@/components/messages/ChatVoiceWaveform";
import { floraColors, floraMessages, floraSpacing } from "@/lib/theme";
import { formatVoiceDuration } from "@/lib/voiceWaveform";
import {
  ensureVoicePlaybackAudioMode,
  replaceVoiceSourceAndPlay,
} from "@/lib/voicePlaybackAudio";

type Props = {
  voiceBlock?: FscpVoiceBlock;
  durationMs: number;
  waveform: number[];
  isFromMe: boolean;
  localUri?: string | null;
};

export function ChatVoiceMessageCard({
  voiceBlock,
  durationMs,
  waveform,
  isFromMe,
  localUri,
}: Props) {
  const playerId = voiceBlock?.assetUuid ?? localUri ?? "local-voice";
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [sourceUri, setSourceUri] = useState<string | null>(
    () =>
      localUri ??
      (voiceBlock
        ? (peekPendingVoiceUri(voiceBlock.assetUuid) ?? peekMessageVoiceUri(voiceBlock.assetUuid))
        : null),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  useEffect(() => {
    if (!sourceUri) return;
    player.replace({ uri: sourceUri });
  }, [player, sourceUri]);

  useEffect(() => {
    return () => releaseVoicePlayback(playerId);
  }, [playerId]);

  useEffect(() => {
    if (status.didJustFinish) {
      releaseVoicePlayback(playerId);
    }
  }, [playerId, status.didJustFinish]);

  const ensureSource = useCallback(async () => {
    if (sourceUri || localUri || !voiceBlock) return sourceUri;
    setLoading(true);
    setError(null);
    try {
      const uri = await ensureMessageVoiceUri(voiceBlock);
      setSourceUri(uri);
      return uri;
    } catch {
      setError("Не удалось загрузить");
      return null;
    } finally {
      setLoading(false);
    }
  }, [localUri, sourceUri, voiceBlock]);

  const toggle = useCallback(async () => {
    const uri = sourceUri ?? (await ensureSource());
    if (!uri) return;

    if (status.playing) {
      player.pause();
      releaseVoicePlayback(playerId);
      return;
    }

    try {
      setError(null);
      await ensureVoicePlaybackAudioMode();
      requestVoicePlayback(playerId, () => player.pause());
      await replaceVoiceSourceAndPlay(player, uri);
      if (!sourceUri) setSourceUri(uri);
    } catch {
      releaseVoicePlayback(playerId);
      setError("Не удалось воспроизвести");
    }
  }, [ensureSource, player, playerId, sourceUri, status.playing]);

  const label = error ?? (loading ? "Загрузка…" : formatVoiceDuration(durationMs));
  const playIconColor = isFromMe ? floraColors.greenDark : floraColors.greenDark;

  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={status.playing ? "Пауза" : "Воспроизвести голосовое"}
        style={({ pressed }) => [
          styles.playBtn,
          isFromMe ? styles.playBtnMe : styles.playBtnThem,
          pressed && styles.playBtnPressed,
        ]}
        onPress={() => void toggle()}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator size="small" color={playIconColor} />
        ) : (
          <Ionicons
            name={status.playing ? "pause" : "play"}
            size={18}
            color={playIconColor}
          />
        )}
      </Pressable>
      <View style={styles.body}>
        <ChatVoiceWaveform levels={waveform} isFromMe={isFromMe} />
        <Text style={[styles.duration, isFromMe ? styles.durationMe : styles.durationThem]}>
          {label}
        </Text>
      </View>
    </View>
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
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 5,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  playBtnThem: {
    backgroundColor: floraColors.greenLight,
    shadowColor: floraColors.greenLight,
    shadowOpacity: 0.28,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  playBtnPressed: {
    opacity: 0.88,
    transform: [{ scale: 0.94 }],
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  duration: {
    fontSize: floraMessages.bubbleTimeFontSize,
    includeFontPadding: false,
    letterSpacing: 0.36,
    lineHeight: 14,
  },
  durationMe: {
    color: "rgba(242, 244, 246, 0.78)",
  },
  durationThem: {
    color: "rgba(143, 143, 143, 0.85)",
  },
});

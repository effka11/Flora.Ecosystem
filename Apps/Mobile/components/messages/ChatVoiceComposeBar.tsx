import { Ionicons } from "@expo/vector-icons";
import { memo, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { ChatVoiceLiveWaveform } from "@/components/messages/ChatVoiceLiveWaveform";
import { ChatVoiceWaveform } from "@/components/messages/ChatVoiceWaveform";
import { floraColors, floraMessages, floraSpacing } from "@/lib/theme";
import { formatVoiceDuration } from "@/lib/voiceWaveform";

type Props = {
  recording: boolean;
  showStopControl?: boolean;
  recordingStartedAt?: number | null;
  waveform: number[];
  transcoding?: boolean;
  onDiscard: () => void;
  onStop: () => void;
  onSend: () => void;
  sending?: boolean;
  canSend?: boolean;
};

function ChatVoiceComposeBarInner({
  recording,
  showStopControl = false,
  recordingStartedAt = null,
  waveform,
  transcoding = false,
  onDiscard,
  onStop,
  onSend,
  sending = false,
  canSend = false,
}: Props) {
  const [recordingMs, setRecordingMs] = useState(0);

  useEffect(() => {
    if (!recording || recordingStartedAt == null) {
      setRecordingMs(0);
      return;
    }
    const tick = () => setRecordingMs(Math.max(0, Date.now() - recordingStartedAt));
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [recording, recordingStartedAt]);

  const timerLabel = formatVoiceDuration(recordingMs);
  const stopVisible = showStopControl || recording;

  return (
    <View style={styles.shell}>
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Удалить запись"
          style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
          onPress={onDiscard}
        >
          <Ionicons name="trash-outline" size={20} color={floraColors.gray} />
        </Pressable>

        <Text style={styles.timer}>{timerLabel}</Text>

        <View style={styles.waveArea}>
          {recording ? (
            <ChatVoiceLiveWaveform isFromMe />
          ) : (
            <ChatVoiceWaveform levels={waveform} isFromMe />
          )}
        </View>

        {stopVisible ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Остановить запись"
            hitSlop={10}
            android_disableSound
            style={({ pressed }) => [styles.stopBtn, pressed && styles.iconBtnPressed]}
            onPress={onStop}
          >
            <View style={styles.stopSquare} />
          </Pressable>
        ) : transcoding ? (
          <View style={styles.iconBtn}>
            <ActivityIndicator color={floraColors.greenLight} size="small" />
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Отправить голосовое"
            style={({ pressed }) => [styles.iconBtn, pressed && styles.iconBtnPressed]}
            onPress={onSend}
            disabled={!canSend || sending}
          >
            {sending ? (
              <ActivityIndicator color={floraColors.greenLight} size="small" />
            ) : (
              <Ionicons
                name="send"
                size={18}
                color={canSend ? floraColors.greenLight : floraColors.gray}
              />
            )}
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    paddingHorizontal: floraSpacing.grid,
    paddingTop: floraMessages.composeShellPaddingTop,
    borderTopWidth: 1,
    borderTopColor: floraMessages.divider,
    backgroundColor: floraColors.bg,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraMessages.composeFieldGap,
    borderWidth: 1,
    borderColor: floraMessages.composeBorderColor,
    borderRadius: floraMessages.composeRadius,
    paddingHorizontal: floraMessages.composeFieldPaddingHorizontal,
    paddingVertical: floraSpacing.gridFine * 2,
    minHeight: floraMessages.composeFieldMinHeight,
  },
  iconBtn: {
    width: floraMessages.composeChromeBtn,
    height: floraMessages.composeChromeBtn,
    alignItems: "center",
    justifyContent: "center",
  },
  iconBtnPressed: {
    opacity: 0.72,
  },
  stopBtn: {
    width: floraMessages.composeChromeBtn,
    height: floraMessages.composeChromeBtn,
    borderRadius: floraMessages.composeChromeBtn / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(220, 60, 60, 0.9)",
  },
  stopSquare: {
    width: 12,
    height: 12,
    borderRadius: 2,
    backgroundColor: floraColors.whiteTemplate,
  },
  waveArea: {
    flex: 1,
    minWidth: 0,
    justifyContent: "center",
  },
  timer: {
    color: floraColors.gray,
    fontSize: floraMessages.bubbleTimeFontSize,
    fontVariant: ["tabular-nums"],
    minWidth: 36,
    textAlign: "left",
  },
});
export const ChatVoiceComposeBar = memo(ChatVoiceComposeBarInner);

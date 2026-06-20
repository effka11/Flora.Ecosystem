import { useEffect, useMemo } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { floraSpacing } from "@/lib/theme";
import {
  bucketVoiceWaveformByMax,
  VOICE_BUBBLE_WAVE_BAR_COUNT,
  VOICE_LIVE_WAVE_BAR_COUNT,
  VOICE_WAVE_MIN_LEVEL,
  voiceWaveBarHeight,
} from "@/lib/voiceWaveform";

type Props = {
  levels: number[];
  isFromMe?: boolean;
  /** При записи — скроллинг без bucket (48 полосок). */
  live?: boolean;
  style?: StyleProp<ViewStyle>;
};

const waveBarMeStyle = { backgroundColor: "rgba(242, 244, 246, 0.58)", opacity: 0.95 } as const;
const waveBarThemStyle = { backgroundColor: "rgba(164, 209, 138, 0.68)", opacity: 0.9 } as const;

export function ChatVoiceWaveform({ levels, isFromMe = true, live = false, style }: Props) {
  const bars = useMemo(() => {
    const emptyCount = live ? VOICE_LIVE_WAVE_BAR_COUNT : VOICE_BUBBLE_WAVE_BAR_COUNT;
    if (levels.length === 0) {
      return Array.from({ length: emptyCount }, () => VOICE_WAVE_MIN_LEVEL);
    }
    if (live) {
      return levels;
    }
    return bucketVoiceWaveformByMax(levels, VOICE_BUBBLE_WAVE_BAR_COUNT);
  }, [levels, live]);

  const toneStyle = isFromMe ? waveBarMeStyle : waveBarThemStyle;

  return (
    <View style={[styles.waveform, style]} accessibilityElementsHidden>
      {bars.map((level, index) => (
        <View
          key={index}
          style={[styles.waveBar, toneStyle, { height: voiceWaveBarHeight(level) }]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  waveform: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 2,
    height: floraSpacing.grid * 2,
    overflow: "hidden",
  },
  waveBar: {
    width: 2,
    borderRadius: 999,
    flexShrink: 0,
  },
});

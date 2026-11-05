import { liveGridStyles } from "@/lib/liveGridStyles";
import { useMemo } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";

import { floraSpacing, sPx, floraColors } from "@/lib/theme";
import { floraTokenAlpha } from "@/lib/floraTheme";
import { useFloraTheme } from "@/lib/FloraThemeProvider";
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

const WAVE_BAR_ME_ALPHA = 0.58;
const WAVE_BAR_THEM_ALPHA = 0.68;

export function ChatVoiceWaveform({ levels, isFromMe = true, live = false, style }: Props) {
  useFloraTheme();
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

  const toneStyle = isFromMe
    ? { backgroundColor: floraTokenAlpha(floraColors.textOnBubble, WAVE_BAR_ME_ALPHA), opacity: 0.95 }
    : { backgroundColor: floraColors.overlay(WAVE_BAR_THEM_ALPHA), opacity: 0.9 };

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

const styles = liveGridStyles(() => StyleSheet.create({
  waveform: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: sPx(2),
    height: floraSpacing.grid * 2,
    overflow: "hidden",
  },
  waveBar: {
    width: sPx(2),
    borderRadius: 999,
    flexShrink: 0,
  },
}));

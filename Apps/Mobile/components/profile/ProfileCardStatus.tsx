import { useState } from "react";
import {
  NativeSyntheticEvent,
  StyleSheet,
  Text,
  TextLayoutEventData,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { floraColors, floraProfile, floraSpacing } from "@/lib/theme";

type TextLine = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ProfileCardStatusProps = {
  status?: string | null;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
};

/** Статус на карточке профиля — как web: правое выравнивание, полоска под каждой визуальной строкой. */
export function ProfileCardStatus({ status, loading = false, style }: ProfileCardStatusProps) {
  const trimmed = (status ?? "").trim();
  const [lines, setLines] = useState<TextLine[]>([]);

  if (!trimmed && !loading) return null;

  const text = loading && !trimmed ? "…" : trimmed;

  const onTextLayout = (event: NativeSyntheticEvent<TextLayoutEventData>) => {
    setLines(
      event.nativeEvent.lines.map((line) => ({
        x: line.x,
        y: line.y,
        width: line.width,
        height: line.height,
      })),
    );
  };

  return (
    <View style={[styles.root, style]}>
      <View style={styles.textLayer}>
        <Text style={styles.text} onTextLayout={onTextLayout}>
          {text}
        </Text>
        {lines.map((line, index) => (
          <View
            key={index}
            pointerEvents="none"
            style={[
              styles.stripe,
              {
                left: line.x,
                top: line.y + line.height,
                width: line.width,
              },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    minWidth: 0,
    width: "100%",
  },
  textLayer: {
    position: "relative",
    width: "100%",
  },
  text: {
    color: floraColors.gray,
    fontSize: floraProfile.statusFontSize,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: floraProfile.statusLineHeight,
    textAlign: "right",
    transform: [{ translateY: floraSpacing.gridFine }],
  },
  stripe: {
    position: "absolute",
    height: 1,
    backgroundColor: floraProfile.statusStripe,
  },
});

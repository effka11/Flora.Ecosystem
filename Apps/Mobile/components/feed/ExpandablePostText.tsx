import { useCallback, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextLayoutEventData,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { floraColors, floraSpacing } from "@/lib/theme";

type ExpandablePostTextProps = {
  text: string;
  hasMedia?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
};

type TextMeasurement = {
  textKey: string;
  canExpand: boolean;
};

const TEXT_ONLY_LINES = 8;
const WITH_MEDIA_LINES = 4;

export function ExpandablePostText({
  text,
  hasMedia = false,
  containerStyle,
  textStyle,
}: ExpandablePostTextProps) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [measurement, setMeasurement] = useState<TextMeasurement | null>(null);
  const collapsedLines = hasMedia ? WITH_MEDIA_LINES : TEXT_ONLY_LINES;
  const textKey = `${collapsedLines}:${text}`;
  const expanded = expandedKey === textKey;
  const canExpand = measurement?.textKey === textKey ? measurement.canExpand : false;

  const onMeasureTextLayout = useCallback(
    (event: NativeSyntheticEvent<TextLayoutEventData>) => {
      const nextCanExpand = event.nativeEvent.lines.length > collapsedLines;
      setMeasurement((value) =>
        value?.textKey === textKey && value.canExpand === nextCanExpand
          ? value
          : { textKey, canExpand: nextCanExpand },
      );
    },
    [collapsedLines, textKey],
  );

  if (text.trim().length === 0) return null;

  return (
    <View style={[styles.root, containerStyle]}>
      <Text style={textStyle} numberOfLines={expanded ? undefined : collapsedLines} ellipsizeMode="tail">
        {text}
      </Text>
      <Text
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
        style={[textStyle, styles.measureText]}
        onTextLayout={onMeasureTextLayout}
      >
        {text}
      </Text>
      {canExpand ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={expanded ? "Свернуть текст поста" : "Показать текст поста полностью"}
          hitSlop={floraSpacing.gridFine}
          style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}
          onPress={() => setExpandedKey((value) => (value === textKey ? null : textKey))}
        >
          <Text style={styles.toggleText}>{expanded ? "Свернуть" : "Показать полностью"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: "relative",
  },
  measureText: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    opacity: 0,
  },
  toggle: {
    alignSelf: "flex-start",
    marginTop: floraSpacing.gridFine,
  },
  toggleText: {
    color: floraColors.greenLight,
    fontSize: 14,
    fontWeight: "300",
    lineHeight: 18,
    letterSpacing: 0.42,
  },
  pressed: {
    opacity: 0.72,
  },
});

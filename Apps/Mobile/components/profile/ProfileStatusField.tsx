import { useState } from "react";
import {
  NativeSyntheticEvent,
  StyleSheet,
  Text,
  TextInput,
  TextLayoutEventData,
  View,
  type TextInputProps,
} from "react-native";
import { floraColors, floraProfile, floraSpacing } from "@/lib/theme";

type TextLine = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ProfileStatusFieldProps = Omit<TextInputProps, "multiline" | "style"> & {
  label?: string;
  value: string;
  onChangeText: (text: string) => void;
};

const TEXTAREA_LINE_HEIGHT = floraSpacing.grid * 1.5;

/** Поле «Описание» — textarea как на web, полоски по визуальным строкам текста. */
export function ProfileStatusField({
  label = "Описание",
  value,
  onChangeText,
  placeholder = "Статус",
  ...rest
}: ProfileStatusFieldProps) {
  const [lines, setLines] = useState<TextLine[]>([]);

  const onMirrorTextLayout = (event: NativeSyntheticEvent<TextLayoutEventData>) => {
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
    <View style={styles.group}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.box}>
        <Text pointerEvents="none" style={styles.mirror} onTextLayout={onMirrorTextLayout}>
          {value.length > 0 ? value : " "}
        </Text>
        <TextInput
          {...rest}
          multiline
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor="rgba(250, 250, 250, 0.3)"
          textAlignVertical="top"
          style={styles.input}
        />
        {lines.map((line, index) => (
          <View
            key={index}
            pointerEvents="none"
            style={[
              styles.stripe,
              {
                left: floraSpacing.grid + line.x,
                top: floraSpacing.grid + line.y + line.height,
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
  group: {
    gap: floraSpacing.gridFine,
  },
  label: {
    color: floraColors.gray,
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.42,
  },
  box: {
    position: "relative",
    minHeight: floraSpacing.grid * 6,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.15)",
    borderRadius: 10,
    overflow: "hidden",
  },
  mirror: {
    position: "absolute",
    opacity: 0,
    left: floraSpacing.grid,
    right: floraSpacing.grid,
    top: floraSpacing.grid,
    fontSize: floraProfile.statusFontSize,
    fontWeight: "300",
    lineHeight: TEXTAREA_LINE_HEIGHT,
  },
  stripe: {
    position: "absolute",
    height: 1,
    backgroundColor: floraProfile.statusStripe,
  },
  input: {
    minHeight: floraSpacing.grid * 6,
    paddingHorizontal: floraSpacing.grid,
    paddingTop: floraSpacing.grid,
    paddingBottom: floraSpacing.grid,
    color: floraColors.whiteTemplate,
    fontSize: floraProfile.statusFontSize,
    fontWeight: "300",
    lineHeight: TEXTAREA_LINE_HEIGHT,
    backgroundColor: "transparent",
  },
});

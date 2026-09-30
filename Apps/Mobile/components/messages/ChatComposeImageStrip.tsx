import { liveGridStyles } from "@/lib/liveGridStyles";
import { Image } from "expo-image";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { floraColors, floraSpacing, kegl, sPx } from "@/lib/theme";
import type { DraftMessageImage } from "@/lib/useMessageComposeImages";

type Props = {
  images: DraftMessageImage[];
  onRemoveAt: (index: number) => void;
};

export function ChatComposeImageStrip({ images, onRemoveAt }: Props) {
  if (images.length === 0) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.strip}
      keyboardShouldPersistTaps="handled"
    >
      {images.map((image, index) => (
        <View key={image.id} style={styles.item}>
          <Image source={{ uri: image.uri }} style={styles.thumb} contentFit="cover" />
          {image.preparing ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>Сжатие…</Text>
            </View>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Убрать фото"
            style={({ pressed }) => [styles.removeBtn, pressed && styles.removeBtnPressed]}
            onPress={() => onRemoveAt(index)}
          >
            <Text style={styles.removeText}>×</Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = liveGridStyles(() => StyleSheet.create({
  strip: {
    gap: floraSpacing.gridFine,
    paddingBottom: floraSpacing.gridFine,
  },
  item: {
    width: sPx(56),
    height: sPx(56),
    borderRadius: 2 * floraSpacing.gridFine,
    overflow: "hidden",
    backgroundColor: floraColors.surfaceElevated,
  },
  thumb: {
    width: "100%",
    height: "100%",
  },
  badge: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingVertical: sPx(2),
  },
  badgeText: {
    color: floraColors.whiteTemplate,
    fontSize: kegl(10),
    textAlign: "center",
  },
  removeBtn: {
    position: "absolute",
    top: sPx(2),
    right: sPx(2),
    width: 4 * floraSpacing.gridFine,
    height: 4 * floraSpacing.gridFine,
    borderRadius: 2 * floraSpacing.gridFine,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.55)",
  },
  removeBtnPressed: {
    opacity: 0.75,
  },
  removeText: {
    color: floraColors.whiteTemplate,
    fontSize: kegl(14),
    lineHeight: sPx(16),
    marginTop: -1,
  },
}));

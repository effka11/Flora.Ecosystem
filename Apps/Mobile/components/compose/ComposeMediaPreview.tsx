import { liveGridStyles } from "@/lib/liveGridStyles";
import { Ionicons } from "@expo/vector-icons";
import { Image } from "expo-image";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { DraftPostImage, DraftPostVideo } from "@/lib/compose/useComposePostMedia";
import { floraColors, floraSpacing } from "@/lib/theme";

type Props = {
  images: DraftPostImage[];
  video: DraftPostVideo | null;
  onRemoveImage: (index: number) => void;
  onRemoveVideo: () => void;
};

export function ComposeMediaPreview({ images, video, onRemoveImage, onRemoveVideo }: Props) {
  if (images.length === 0 && !video) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      style={styles.scroll}
    >
      {images.map((image, index) => (
        <View key={image.id} style={styles.thumbWrap}>
          <Image source={{ uri: image.uri }} style={styles.thumb} contentFit="cover" />
          {image.preparing ? <View style={styles.preparing} /> : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Удалить фото"
            style={({ pressed }) => [styles.remove, pressed && styles.pressed]}
            onPress={() => onRemoveImage(index)}
            hitSlop={8}
          >
            <Ionicons name="close" size={14} color={floraColors.whiteTemplate} />
          </Pressable>
        </View>
      ))}
      {video ? (
        <View style={styles.thumbWrap}>
          <View style={[styles.thumb, styles.videoThumb]}>
            <Ionicons name="videocam" size={28} color={floraColors.greenLight} />
            <Text style={styles.videoLabel} numberOfLines={1}>
              Видео
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Удалить видео"
            style={({ pressed }) => [styles.remove, pressed && styles.pressed]}
            onPress={onRemoveVideo}
            hitSlop={8}
          >
            <Ionicons name="close" size={14} color={floraColors.whiteTemplate} />
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  );
}

const THUMB = () => floraSpacing.grid * 5;

const styles = liveGridStyles(() => StyleSheet.create({
  scroll: {
    flexGrow: 0,
  },
  row: {
    flexDirection: "row",
    gap: floraSpacing.gridFine * 2,
    paddingVertical: floraSpacing.gridFine,
  },
  thumbWrap: {
    width: THUMB(),
    height: THUMB(),
  },
  thumb: {
    width: THUMB(),
    height: THUMB(),
    borderRadius: 10,
    backgroundColor: floraColors.surface,
  },
  videoThumb: {
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.08)",
  },
  videoLabel: {
    color: floraColors.gray,
    fontSize: 11,
    fontWeight: "300",
    maxWidth: THUMB() - 12,
  },
  preparing: {
    ...StyleSheet.absoluteFill,
    borderRadius: 10,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  remove: {
    position: "absolute",
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.65)",
  },
  pressed: {
    opacity: 0.72,
  },
}));

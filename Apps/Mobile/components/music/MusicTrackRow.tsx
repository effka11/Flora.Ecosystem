import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { MusicTrackItem } from "@/lib/music/musicModels";
import { formatMusicDuration } from "@/lib/music/musicModels";
import { floraColors, floraSpacing } from "@/lib/theme";

type Props = {
  track: MusicTrackItem;
  playing?: boolean;
  onPress: () => void;
  onDelete?: () => void;
};

export function MusicTrackRow({ track, playing = false, onPress, onDelete }: Props) {
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && styles.pressed]} onPress={onPress}>
      <View style={[styles.cover, { backgroundColor: track.coverColor }]}>
        <Ionicons
          name={playing ? "pause" : "musical-note"}
          size={18}
          color={playing ? floraColors.greenDark : "rgba(12, 12, 12, 0.82)"}
        />
      </View>
      <View style={styles.meta}>
        <Text style={styles.title} numberOfLines={1}>
          {track.title}
        </Text>
        <Text style={styles.artist} numberOfLines={1}>
          {track.artist}
        </Text>
      </View>
      <Text style={styles.duration}>{formatMusicDuration(track.durationMs)}</Text>
      {onDelete ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Удалить трек"
          hitSlop={10}
          style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
          onPress={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          <Ionicons name="trash-outline" size={17} color={floraColors.gray} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 64,
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.gridFine * 2,
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.gridFine * 2,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(250, 250, 250, 0.08)",
  },
  cover: {
    width: 42,
    height: 42,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  meta: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  artist: {
    color: floraColors.gray,
    fontSize: 12,
    fontWeight: "300",
    letterSpacing: 0.36,
    marginTop: 3,
  },
  duration: {
    color: floraColors.gray,
    fontSize: 12,
    fontWeight: "300",
    minWidth: 38,
    textAlign: "right",
  },
  iconBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: {
    opacity: 0.72,
  },
});

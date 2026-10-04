import { liveGridStyles } from "@/lib/liveGridStyles";
import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { MusicTrackItem } from "@/lib/music/musicModels";
import { formatMusicDuration } from "@/lib/music/musicModels";
import { useSPx } from "@/lib/FloraGridProvider";
import { floraColors, floraSpacing, kegl, sPx, tracking } from "@/lib/theme";

type Props = {
  track: MusicTrackItem;
  playing?: boolean;
  onPress: () => void;
  onDelete?: () => void;
};

export function MusicTrackRow({ track, playing = false, onPress, onDelete }: Props) {
  const sp = useSPx();
  return (
    <Pressable style={({ pressed }) => [styles.row, pressed && styles.pressed]} onPress={onPress}>
      <View style={[styles.cover, { backgroundColor: track.coverColor }]}>
        <Ionicons
          name={playing ? "pause" : "musical-note"}
          size={sp(18)}
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
          hitSlop={sp(10)}
          style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
          onPress={(event) => {
            event.stopPropagation();
            onDelete();
          }}
        >
          <Ionicons name="trash-outline" size={sp(17)} color={floraColors.gray} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

const styles = liveGridStyles(() => StyleSheet.create({
  row: {
    minHeight: sPx(64),
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.gridFine * 2,
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.gridFine * 2,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(250, 250, 250, 0.08)",
  },
  cover: {
    width: sPx(42),
    height: sPx(42),
    borderRadius: sPx(12),
    alignItems: "center",
    justifyContent: "center",
  },
  meta: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: floraColors.whiteTemplate,
    fontSize: kegl(15),
    fontWeight: "300",
    letterSpacing: tracking(0.45),
  },
  artist: {
    color: floraColors.gray,
    fontSize: kegl(12),
    fontWeight: "300",
    letterSpacing: tracking(0.36),
    marginTop: sPx(3),
  },
  duration: {
    color: floraColors.gray,
    fontSize: kegl(12),
    fontWeight: "300",
    minWidth: sPx(38),
    textAlign: "right",
  },
  iconBtn: {
    width: sPx(28),
    height: sPx(28),
    borderRadius: sPx(14),
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: {
    opacity: 0.72,
  },
}));

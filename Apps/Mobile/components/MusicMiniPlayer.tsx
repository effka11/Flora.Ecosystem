import { Ionicons } from "@expo/vector-icons";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { usePathname } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { mobileSessionStore } from "@/lib/session";
import { useMusicStore } from "@/stores/musicStore";
import { formatMusicDuration } from "@/lib/music/musicModels";
import { floraColors, floraSpacing, floraTabBarHeight } from "@/lib/theme";

function isMessagesPath(pathname: string): boolean {
  return pathname === "/messages" || pathname.startsWith("/messages/");
}

export function MusicMiniPlayer() {
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const current = useMusicStore((s) => s.current);
  const playing = useMusicStore((s) => s.playing);
  const togglePlay = useMusicStore((s) => s.togglePlay);
  const next = useMusicStore((s) => s.next);
  const prev = useMusicStore((s) => s.prev);
  const seek = useMusicStore((s) => s.seek);
  const seekRequestMs = useMusicStore((s) => s.seekRequestMs);
  const positionMs = useMusicStore((s) => s.positionMs);
  const durationMsFromStore = useMusicStore((s) => s.durationMs);
  const consumeSeekRequest = useMusicStore((s) => s.consumeSeekRequest);
  const setPlaybackProgress = useMusicStore((s) => s.setPlaybackProgress);
  const streamUrl = useMusicStore((s) => s.streamUrl);
  const stop = useMusicStore((s) => s.stop);
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player) as {
    currentTime?: number;
    duration?: number;
    didJustFinish?: boolean;
  };
  const [progressWidth, setProgressWidth] = useState(1);

  useEffect(() => {
    if (!current) return;
    let cancelled = false;
    (async () => {
      const url = await streamUrl(current.id);
      const token = await mobileSessionStore.getAccessToken();
      if (cancelled) return;
      player.replace({
        uri: url,
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (playing) player.play();
    })();
    return () => {
      cancelled = true;
    };
  }, [current?.id, player, streamUrl]);

  useEffect(() => {
    if (playing) player.play();
    else player.pause();
  }, [playing, player]);

  useEffect(() => {
    const positionMs = Math.max(0, Math.round((status.currentTime ?? 0) * 1000));
    const durationMs =
      status.duration !== undefined
        ? Math.max(0, Math.round(status.duration * 1000))
        : Math.max(0, current?.durationMs ?? 0);
    setPlaybackProgress(positionMs, durationMs);
  }, [current?.durationMs, setPlaybackProgress, status.currentTime, status.duration]);

  useEffect(() => {
    const request = consumeSeekRequest();
    if (request === null) return;
    const seekable = player as unknown as { seekTo?: (seconds: number) => void };
    seekable.seekTo?.(request / 1000);
  }, [consumeSeekRequest, player, seekRequestMs]);

  useEffect(() => {
    if (!current) {
      player.pause();
    }
  }, [current, player]);

  useEffect(() => {
    if (status.didJustFinish) void next();
  }, [next, status.didJustFinish]);

  if (!current || isMessagesPath(pathname)) return null;

  const durationMs = durationMsFromStore || current.durationMs;
  const progress = durationMs > 0 ? Math.min(1, positionMs / durationMs) : 0;

  const onProgressLayout = (event: LayoutChangeEvent) => {
    setProgressWidth(Math.max(1, event.nativeEvent.layout.width));
  };

  return (
    <View
      style={[
        styles.bar,
        { bottom: floraTabBarHeight + insets.bottom },
      ]}
    >
      <View style={[styles.cover, { backgroundColor: current.coverColor }]}>
        <Ionicons name="musical-notes" size={18} color={floraColors.greenDark} />
      </View>
      <View style={styles.meta}>
        <Text style={styles.title} numberOfLines={1}>
          {current.title}
        </Text>
        <Text style={styles.artist} numberOfLines={1}>
          {current.artist}
        </Text>
        <Pressable
          accessibilityRole="adjustable"
          style={styles.progressTrack}
          onLayout={onProgressLayout}
          onPress={(event) => {
            const ratio = Math.min(1, Math.max(0, event.nativeEvent.locationX / progressWidth));
            seek(ratio * durationMs);
          }}
        >
          <View style={[styles.progressFill, { width: `${progress * 100}%` }]} />
        </Pressable>
      </View>
      <Text style={styles.time}>{formatMusicDuration(positionMs)}</Text>
      <Pressable style={({ pressed }) => [styles.control, pressed && styles.pressed]} onPress={prev}>
        <Ionicons name="play-skip-back" size={18} color={floraColors.greenLight} />
      </Pressable>
      <Pressable style={({ pressed }) => [styles.playControl, pressed && styles.pressed]} onPress={togglePlay}>
        <Ionicons name={playing ? "pause" : "play"} size={18} color={floraColors.greenDark} />
      </Pressable>
      <Pressable style={({ pressed }) => [styles.control, pressed && styles.pressed]} onPress={() => void next()}>
        <Ionicons name="play-skip-forward" size={18} color={floraColors.greenLight} />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Скрыть плеер"
        style={({ pressed }) => [styles.closeBtn, pressed && styles.pressed]}
        onPress={stop}
        hitSlop={6}
      >
        <Ionicons name="close" size={20} color={floraColors.gray} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: floraColors.surfaceElevated,
    borderTopColor: floraColors.border,
    borderTopWidth: 1,
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.gridFine * 2,
    gap: floraSpacing.gridFine * 2,
  },
  cover: {
    width: 38,
    height: 38,
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
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.42,
  },
  artist: {
    color: floraColors.textMuted,
    fontSize: 12,
    fontWeight: "300",
    marginTop: 2,
  },
  progressTrack: {
    height: 3,
    borderRadius: 999,
    backgroundColor: "rgba(250, 250, 250, 0.13)",
    marginTop: floraSpacing.gridFine,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 999,
    backgroundColor: floraColors.greenLight,
  },
  time: {
    color: floraColors.gray,
    fontSize: 11,
    minWidth: 34,
    textAlign: "right",
  },
  control: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  playControl: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: floraColors.greenLight,
  },
  closeBtn: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: floraSpacing.gridFine,
  },
  pressed: {
    opacity: 0.72,
  },
});

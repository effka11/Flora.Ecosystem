import { Ionicons } from "@expo/vector-icons";
import { apiDeleteMusicPlaylist, apiGetMusicPlaylistDetail } from "@flora/client-core/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MusicDetailLayout } from "@/components/music/MusicDetailLayout";
import { MusicTracksList } from "@/components/music/MusicSections";
import { mapPlaylistDetailDto } from "@/lib/music/musicModels";
import { musicTrackItemsToPlayerTracks } from "@/lib/music/musicPlayerMapping";
import { useMusicStore } from "@/stores/musicStore";
import { floraColors, floraSpacing } from "@/lib/theme";

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default function MusicPlaylistScreen() {
  const params = useLocalSearchParams<{ playlistId?: string }>();
  const playlistId = routeParam(params.playlistId);
  const queryClient = useQueryClient();
  const playQueue = useMusicStore((s) => s.playQueue);
  const playlistQuery = useQuery({
    queryKey: ["music-playlist", playlistId],
    enabled: playlistId.length > 0,
    queryFn: async () => mapPlaylistDetailDto(await apiGetMusicPlaylistDetail(playlistId)),
  });
  const playlist = playlistQuery.data;

  const deletePlaylist = () => {
    if (!playlist?.canDelete) return;
    Alert.alert("Удалить плейлист", `Удалить «${playlist.title}»?`, [
      { text: "Отмена", style: "cancel" },
      {
        text: "Удалить",
        style: "destructive",
        onPress: () => {
          void (async () => {
            await apiDeleteMusicPlaylist(playlist.id);
            await queryClient.invalidateQueries({ queryKey: ["music-playlists"] });
            router.back();
          })();
        },
      },
    ]);
  };

  return (
    <MusicDetailLayout
      title={playlist?.title ?? "Плейлист"}
      subtitle={playlist ? `${playlist.trackCount} треков` : null}
      action={
        playlist?.canDelete ? (
          <Pressable style={({ pressed }) => [styles.headerBtn, pressed && styles.pressed]} onPress={deletePlaylist}>
            <Ionicons name="trash-outline" size={18} color={floraColors.gray} />
          </Pressable>
        ) : null
      }
    >
      {playlistQuery.isLoading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={floraColors.greenLight} />
        </View>
      ) : playlistQuery.isError || !playlist ? (
        <Text style={styles.emptyHint}>Не удалось загрузить плейлист.</Text>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.hero}>
            <View style={[styles.heroCover, { backgroundColor: playlist.coverColor }]} />
            <View style={styles.heroMeta}>
              <Text style={styles.heroTitle}>{playlist.title}</Text>
              <Text style={styles.heroSubtitle}>{playlist.trackCount} треков</Text>
              <Pressable
                style={({ pressed }) => [styles.playAllBtn, pressed && styles.pressed, playlist.tracks?.length === 0 && styles.disabled]}
                onPress={() => {
                  const tracks = playlist.tracks ?? [];
                  if (tracks.length > 0) {
                    playQueue(musicTrackItemsToPlayerTracks(tracks), 0, { sourceId: `playlist:${playlist.id}` });
                  }
                }}
                disabled={(playlist.tracks?.length ?? 0) === 0}
              >
                <Ionicons name="play" size={16} color={floraColors.greenDark} />
                <Text style={styles.playAllText}>Слушать</Text>
              </Pressable>
            </View>
          </View>
          <MusicTracksList title="Треки" tracks={playlist.tracks ?? []} sourceId={`playlist:${playlist.id}`} />
        </ScrollView>
      )}
    </MusicDetailLayout>
  );
}

const styles = StyleSheet.create({
  content: {
    paddingVertical: floraSpacing.grid,
    paddingBottom: floraSpacing.grid * 7,
    gap: floraSpacing.grid,
  },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyHint: {
    color: floraColors.gray,
    textAlign: "center",
    marginTop: floraSpacing.grid * 3,
  },
  headerBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
  },
  hero: {
    marginHorizontal: floraSpacing.grid,
    flexDirection: "row",
    gap: floraSpacing.grid,
    padding: floraSpacing.grid,
    borderRadius: 18,
    backgroundColor: floraColors.surface,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.08)",
  },
  heroCover: {
    width: 92,
    height: 92,
    borderRadius: 20,
  },
  heroMeta: {
    flex: 1,
    minWidth: 0,
    justifyContent: "center",
    gap: floraSpacing.gridFine,
  },
  heroTitle: {
    color: floraColors.whiteTemplate,
    fontSize: 20,
    fontWeight: "300",
  },
  heroSubtitle: {
    color: floraColors.gray,
    fontSize: 13,
  },
  playAllBtn: {
    alignSelf: "flex-start",
    minHeight: 36,
    borderRadius: 999,
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.gridFine,
    paddingHorizontal: floraSpacing.grid,
    backgroundColor: floraColors.greenLight,
    marginTop: floraSpacing.gridFine,
  },
  playAllText: {
    color: floraColors.greenDark,
    fontSize: 14,
  },
  pressed: {
    opacity: 0.72,
  },
  disabled: {
    opacity: 0.5,
  },
});

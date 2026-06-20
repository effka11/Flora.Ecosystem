import { Ionicons } from "@expo/vector-icons";
import { apiGetMusicArtist, apiGetMusicArtistTracks } from "@flora/client-core/api";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MusicDetailLayout } from "@/components/music/MusicDetailLayout";
import { MusicTracksList } from "@/components/music/MusicSections";
import { mapMusicTracksDto } from "@/lib/music/musicModels";
import { musicTrackItemsToPlayerTracks } from "@/lib/music/musicPlayerMapping";
import { useMusicStore } from "@/stores/musicStore";
import { floraColors, floraSpacing } from "@/lib/theme";

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default function MusicArtistScreen() {
  const params = useLocalSearchParams<{ artistUuid?: string }>();
  const artistUuid = routeParam(params.artistUuid);
  const playQueue = useMusicStore((s) => s.playQueue);

  const artistQuery = useQuery({
    queryKey: ["music-artist", artistUuid],
    enabled: artistUuid.length > 0,
    queryFn: () => apiGetMusicArtist(artistUuid),
  });
  const tracksQuery = useQuery({
    queryKey: ["music-artist-tracks", artistUuid, 1],
    enabled: artistUuid.length > 0,
    queryFn: () => apiGetMusicArtistTracks(artistUuid, 1, 40),
  });

  const artist = artistQuery.data;
  const tracks = mapMusicTracksDto(tracksQuery.data?.tracks ?? []);

  return (
    <MusicDetailLayout title={artist?.displayName ?? "Исполнитель"} subtitle={artist ? `${artist.tracksCount} треков` : null}>
      {artistQuery.isLoading || tracksQuery.isLoading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={floraColors.greenLight} />
        </View>
      ) : artistQuery.isError || !artist ? (
        <Text style={styles.emptyHint}>Не удалось загрузить исполнителя.</Text>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.hero}>
            <View style={styles.artistCover}>
              <Ionicons name="person" size={34} color={floraColors.greenDark} />
            </View>
            <View style={styles.heroMeta}>
              <Text style={styles.heroTitle}>{artist.displayName}</Text>
              <Text style={styles.heroSubtitle}>{artist.tracksCount} треков</Text>
              <Pressable
                style={({ pressed }) => [styles.playAllBtn, pressed && styles.pressed, tracks.length === 0 && styles.disabled]}
                onPress={() => {
                  if (tracks.length > 0) {
                    playQueue(musicTrackItemsToPlayerTracks(tracks), 0, { sourceId: `artist:${artist.artistUuid}` });
                  }
                }}
                disabled={tracks.length === 0}
              >
                <Ionicons name="play" size={16} color={floraColors.greenDark} />
                <Text style={styles.playAllText}>Слушать</Text>
              </Pressable>
            </View>
          </View>
          <MusicTracksList title="Треки исполнителя" tracks={tracks} sourceId={`artist:${artist.artistUuid}`} />
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
  artistCover: {
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: floraColors.greenLight,
    alignItems: "center",
    justifyContent: "center",
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

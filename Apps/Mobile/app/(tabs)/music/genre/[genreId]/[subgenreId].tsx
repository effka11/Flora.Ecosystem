import { apiGetMusicGenrePage } from "@flora/client-core/api";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { MusicDetailLayout } from "@/components/music/MusicDetailLayout";
import { MusicFlowCard, MusicTracksList } from "@/components/music/MusicSections";
import { mapMusicTracksDto } from "@/lib/music/musicModels";
import { floraColors, floraSpacing } from "@/lib/theme";

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default function MusicSubgenreScreen() {
  const params = useLocalSearchParams<{ genreId?: string; subgenreId?: string }>();
  const genreId = routeParam(params.genreId);
  const subgenreId = routeParam(params.subgenreId);
  const genreQuery = useQuery({
    queryKey: ["music-genre", genreId, subgenreId],
    enabled: genreId.length > 0 && subgenreId.length > 0,
    queryFn: () => apiGetMusicGenrePage(genreId, subgenreId),
  });

  const page = genreQuery.data;
  const title = page?.activeSubgenre?.title ?? page?.genre.title ?? "Поджанр";

  return (
    <MusicDetailLayout title={title} subtitle={page?.genre.title ?? null}>
      {genreQuery.isLoading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={floraColors.greenLight} />
        </View>
      ) : genreQuery.isError || !page ? (
        <Text style={styles.emptyHint}>Не удалось загрузить поджанр.</Text>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <MusicFlowCard
            genreId={genreId}
            subgenreId={subgenreId}
            title={`${title}: поток`}
            subtitle="Рекомендации по поджанру"
          />
          {page.collections.map((collection) => (
            <MusicTracksList
              key={collection.id}
              title={collection.title}
              tracks={mapMusicTracksDto(collection.tracks)}
              sourceId={`genre:${genreId}:${subgenreId}:${collection.id}`}
            />
          ))}
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
});

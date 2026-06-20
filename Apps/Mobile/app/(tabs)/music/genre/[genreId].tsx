import { apiGetMusicGenrePage } from "@flora/client-core/api";
import { useQuery } from "@tanstack/react-query";
import { router, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { MusicDetailLayout } from "@/components/music/MusicDetailLayout";
import { MusicFlowCard, MusicTracksList } from "@/components/music/MusicSections";
import { mapMusicTracksDto } from "@/lib/music/musicModels";
import { floraColors, floraSpacing } from "@/lib/theme";

function routeParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

export default function MusicGenreScreen() {
  const params = useLocalSearchParams<{ genreId?: string }>();
  const genreId = routeParam(params.genreId);
  const genreQuery = useQuery({
    queryKey: ["music-genre", genreId],
    enabled: genreId.length > 0,
    queryFn: () => apiGetMusicGenrePage(genreId),
  });

  const page = genreQuery.data;
  const title = page?.genre.title ?? "Жанр";

  return (
    <MusicDetailLayout title={title} subtitle={page ? `${page.genre.trackCount} треков` : null}>
      {genreQuery.isLoading ? (
        <View style={styles.loading}>
          <ActivityIndicator color={floraColors.greenLight} />
        </View>
      ) : genreQuery.isError || !page ? (
        <Text style={styles.emptyHint}>Не удалось загрузить жанр.</Text>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <MusicFlowCard genreId={genreId} title={`${page.genre.title}: поток`} subtitle="Рекомендации по жанру" />
          {page.genre.subgenres.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Поджанры</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
                {page.genre.subgenres.map((subgenre) => (
                  <Pressable
                    key={subgenre.id}
                    style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
                    onPress={() =>
                      router.push({
                        pathname: "/(tabs)/music/genre/[genreId]/[subgenreId]",
                        params: { genreId, subgenreId: subgenre.id },
                      })
                    }
                  >
                    <Text style={styles.chipText}>{subgenre.title}</Text>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ) : null}
          {page.collections.map((collection) => (
            <MusicTracksList
              key={collection.id}
              title={collection.title}
              tracks={mapMusicTracksDto(collection.tracks)}
              sourceId={`genre:${genreId}:${collection.id}`}
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
  section: {
    gap: floraSpacing.gridFine * 2,
  },
  sectionTitle: {
    color: floraColors.whiteTemplate,
    fontSize: 18,
    fontWeight: "300",
    paddingHorizontal: floraSpacing.grid,
  },
  chips: {
    gap: floraSpacing.gridFine * 2,
    paddingHorizontal: floraSpacing.grid,
  },
  chip: {
    minHeight: 34,
    borderRadius: 999,
    paddingHorizontal: floraSpacing.grid,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: floraColors.greenDark,
  },
  chipText: {
    color: floraColors.greenLight,
    fontSize: 13,
  },
  pressed: {
    opacity: 0.72,
  },
});

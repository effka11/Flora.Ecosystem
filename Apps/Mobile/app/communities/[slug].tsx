import { apiGetCommunityBySlug, apiJoinCommunity } from "@flora/client-core/api";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { floraColors } from "@/lib/theme";

export default function CommunityScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const query = useQuery({
    queryKey: ["community", slug],
    enabled: !!slug,
    queryFn: () => apiGetCommunityBySlug(slug!),
  });
  const community = query.data as Record<string, unknown> | undefined;

  return (
    <View style={styles.root}>
      <Text style={styles.name}>{String(community?.name ?? slug)}</Text>
      <Text style={styles.meta}>{String(community?.description ?? "")}</Text>
      <Pressable
        style={styles.button}
        onPress={async () => {
          const id = String(community?.communityUuid ?? slug);
          await apiJoinCommunity(id);
          await query.refetch();
        }}
      >
        <Text style={styles.buttonText}>Вступить</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: floraColors.bg, padding: 16, gap: 12 },
  name: { color: floraColors.text, fontSize: 22, fontWeight: "700" },
  meta: { color: floraColors.textMuted },
  button: {
    backgroundColor: floraColors.accentDark,
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: "center",
  },
  buttonText: { color: floraColors.text, fontWeight: "600" },
});

import { apiCreatePost } from "@flora/client-core/api";
import { isApiRequestError } from "@flora/client-core/api";
import { router, useLocalSearchParams, useNavigation } from "expo-router";
import { useLayoutEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { floraColors } from "@/lib/theme";

export default function ComposeScreen() {
  const { communityUuid: rawCommunityUuid } = useLocalSearchParams<{ communityUuid?: string | string[] }>();
  const communityUuid = Array.isArray(rawCommunityUuid) ? rawCommunityUuid[0] : rawCommunityUuid;
  const navigation = useNavigation();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => {
    navigation.setOptions({
      title: communityUuid ? "Пост в сообществе" : "Новый пост",
    });
  }, [communityUuid, navigation]);

  const onPublish = async () => {
    if (!text.trim()) return;
    setLoading(true);
    setError(null);
    try {
      await apiCreatePost({
        text: text.trim(),
        ...(communityUuid ? { communityUuid } : {}),
      });
      router.back();
    } catch (e) {
      setError(isApiRequestError(e) ? e.message : "Не удалось опубликовать");
    } finally {
      setLoading(false);
    }
  };

  return (
    <View style={styles.root}>
      <TextInput
        style={styles.input}
        placeholder="Что нового?"
        placeholderTextColor={floraColors.textMuted}
        multiline
        value={text}
        onChangeText={setText}
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable style={styles.button} onPress={onPublish} disabled={loading}>
        {loading ? <ActivityIndicator color={floraColors.text} /> : <Text style={styles.buttonText}>Опубликовать</Text>}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: floraColors.bg, padding: 16, gap: 12 },
  input: {
    flex: 1,
    backgroundColor: floraColors.surface,
    borderColor: floraColors.border,
    borderWidth: 1,
    borderRadius: 8,
    color: floraColors.text,
    padding: 14,
    textAlignVertical: "top",
  },
  button: {
    backgroundColor: floraColors.accentDark,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
  },
  buttonText: { color: floraColors.text, fontWeight: "600" },
  error: { color: floraColors.error },
});

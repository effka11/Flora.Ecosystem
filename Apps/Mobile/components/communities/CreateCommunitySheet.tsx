import { Ionicons } from "@expo/vector-icons";
import { apiCreateCommunity } from "@flora/client-core/api";
import { parseCommunityListItem, type CommunityListItemDto } from "@flora/client-core/contracts";
import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  COMMUNITY_SLUG_FORMAT_MESSAGE,
  COMMUNITY_SLUG_RE,
  hasOnlyCommunitySlugChars,
  normalizeCommunitySlug,
} from "@/lib/communitySlug";
import { isReservedCommunitySlug, RESERVED_COMMUNITY_SLUG_MESSAGE } from "@/lib/communityReservedSlugs";
import { floraColors, floraSpacing } from "@/lib/theme";

type Props = {
  visible: boolean;
  onClose: () => void;
  onCreated: (community: CommunityListItemDto) => void;
};

export function CreateCommunitySheet({ visible, onClose, onCreated }: Props) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [isPublic, setIsPublic] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setName("");
    setSlug("");
    setSlugTouched(false);
    setIsPublic(false);
    setSubmitting(false);
    setError(null);
  }, [visible]);

  const onNameChange = (value: string) => {
    setName(value);
    setError(null);
    if (!slugTouched) setSlug(normalizeCommunitySlug(value));
  };

  const onSlugChange = (value: string) => {
    setSlugTouched(true);
    setSlug(normalizeCommunitySlug(value));
    setError(null);
  };

  const submit = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Укажите название сообщества.");
      return;
    }
    if (trimmedName.length > 100) {
      setError("Название не более 100 символов.");
      return;
    }
    if (slugTouched && !hasOnlyCommunitySlugChars(slug)) {
      setError(COMMUNITY_SLUG_FORMAT_MESSAGE);
      return;
    }
    const normalizedSlug = normalizeCommunitySlug(slugTouched ? slug : trimmedName);
    if (!normalizedSlug) {
      setError("Ссылка не может быть пустой. Используйте латиницу, цифры, дефис или подчёркивание.");
      return;
    }
    if (!COMMUNITY_SLUG_RE.test(normalizedSlug)) {
      setError(COMMUNITY_SLUG_FORMAT_MESSAGE);
      return;
    }
    if (isReservedCommunitySlug(normalizedSlug)) {
      setError(RESERVED_COMMUNITY_SLUG_MESSAGE);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const raw = await apiCreateCommunity({
        name: trimmedName,
        ...(slugTouched ? { slug: normalizedSlug } : {}),
        isPrivate: !isPublic,
      });
      const created = parseCommunityListItem(raw);
      if (!created) throw new Error("Некорректный ответ сервера.");
      onCreated({ ...created, role: "Owner" });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось создать сообщество.");
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={[styles.root, { paddingTop: insets.top + floraSpacing.grid, paddingBottom: insets.bottom + floraSpacing.grid }]}>
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Закрыть"
            style={({ pressed }) => [styles.headerSide, pressed && styles.pressed]}
            onPress={onClose}
          >
            <Ionicons name="close" size={24} color={floraColors.gray} />
          </Pressable>
          <Text style={styles.title}>Новое сообщество</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Создать"
            disabled={submitting}
            style={({ pressed }) => [styles.headerSide, styles.headerAction, pressed && styles.pressed, submitting && styles.disabled]}
            onPress={() => void submit()}
          >
            {submitting ? (
              <ActivityIndicator color={floraColors.greenLight} size="small" />
            ) : (
              <Text style={styles.headerActionText}>Создать</Text>
            )}
          </Pressable>
        </View>

        <View style={styles.form}>
          <View style={styles.field}>
            <Text style={styles.label}>Название</Text>
            <TextInput
              style={styles.input}
              placeholder="Например, Flora Design"
              placeholderTextColor={floraColors.gray}
              value={name}
              onChangeText={onNameChange}
              maxLength={100}
              editable={!submitting}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Ссылка</Text>
            <View style={styles.slugRow}>
              <Text style={styles.slugPrefix}>communities/</Text>
              <TextInput
                style={[styles.input, styles.slugInput]}
                placeholder="flora-design"
                placeholderTextColor={floraColors.gray}
                value={slug}
                onChangeText={onSlugChange}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!submitting}
              />
            </View>
          </View>

          <View style={styles.switchRow}>
            <View style={styles.switchBody}>
              <Text style={styles.switchLabel}>Публичное сообщество</Text>
              <Text style={styles.switchHint}>Публичные сообщества видны в поиске и рекомендациях.</Text>
            </View>
            <Switch
              value={isPublic}
              onValueChange={setIsPublic}
              disabled={submitting}
              trackColor={{ false: floraColors.greenDark, true: "rgba(164, 209, 138, 0.45)" }}
              thumbColor={isPublic ? floraColors.greenLight : floraColors.gray}
            />
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: floraColors.bg,
    paddingHorizontal: floraSpacing.grid,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: floraSpacing.grid * 2,
  },
  headerSide: {
    width: 72,
    minHeight: 36,
    alignItems: "flex-start",
    justifyContent: "center",
  },
  headerAction: {
    alignItems: "flex-end",
  },
  headerActionText: {
    color: floraColors.greenLight,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  title: {
    color: floraColors.whiteTemplate,
    fontSize: 16,
    fontWeight: "300",
    letterSpacing: 0.48,
  },
  form: {
    gap: floraSpacing.grid * 2,
  },
  field: {
    gap: floraSpacing.gridFine,
  },
  label: {
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.39,
  },
  input: {
    minHeight: 45,
    borderColor: floraColors.greenDark,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 14,
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  slugRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.gridFine,
  },
  slugPrefix: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  slugInput: {
    flex: 1,
    minWidth: 0,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
    paddingTop: floraSpacing.gridFine,
  },
  switchBody: {
    flex: 1,
    gap: floraSpacing.gridFine,
  },
  switchLabel: {
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  switchHint: {
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.39,
    lineHeight: 18,
  },
  error: {
    color: floraColors.error,
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.42,
    lineHeight: 20,
  },
  pressed: {
    opacity: 0.72,
  },
  disabled: {
    opacity: 0.45,
  },
});

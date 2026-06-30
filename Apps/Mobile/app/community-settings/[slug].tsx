import {
  apiDeleteCommunity,
  apiGetCommunityBySlug,
  apiUpdateCommunity,
} from "@flora/client-core/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as ImagePicker from "expo-image-picker";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloraAvatar } from "@/components/FloraAvatar";
import {
  communityAvatarUploadErrorMessage,
  uploadCommunityAvatarFromPickerAsset,
} from "@/lib/communityAvatarUpload";
import {
  communitySettingsDraftFromProfile,
  communitySettingsDraftHasChanges,
  communitySettingsDraftToUpdatePayload,
  validateCommunitySettingsDraft,
  type CommunitySettingsDraft,
} from "@/lib/communitySettingsDraft";
import { COMMUNITY_SLUG_FORMAT_MESSAGE, hasOnlyCommunitySlugChars } from "@/lib/communitySlug";
import { communityScreenHref, decodeRouteParam } from "@/lib/socialRoutes";
import { floraColors, floraSpacing } from "@/lib/theme";

export default function CommunitySettingsScreen() {
  const { slug: rawSlug } = useLocalSearchParams<{ slug: string | string[] }>();
  const slug = decodeRouteParam(Array.isArray(rawSlug) ? rawSlug[0] ?? "" : rawSlug ?? "");
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

  const communityQuery = useQuery({
    queryKey: ["community", slug],
    enabled: slug.length > 0,
    queryFn: () => apiGetCommunityBySlug(slug),
  });

  const community = communityQuery.data;
  const [draft, setDraft] = useState<CommunitySettingsDraft | null>(null);
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarCacheVersion, setAvatarCacheVersion] = useState(0);
  const [deleteConfirmName, setDeleteConfirmName] = useState("");
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (community) {
      setDraft(communitySettingsDraftFromProfile(community));
    }
  }, [community?.communityId]);

  const hasChanges = useMemo(() => {
    if (!community || !draft) return false;
    return communitySettingsDraftHasChanges(draft, community);
  }, [community, draft]);

  const updateDraft = useCallback((patch: Partial<CommunitySettingsDraft>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setSaveError(null);
  }, []);

  const handleSave = useCallback(async () => {
    if (!community || !draft || saveBusy || !hasChanges) return;
    const validationError = validateCommunitySettingsDraft(draft);
    if (validationError) {
      setSaveError(validationError);
      return;
    }
    setSaveBusy(true);
    setSaveError(null);
    const oldSlug = community.slug;
    try {
      const payload = communitySettingsDraftToUpdatePayload(draft);
      const updated = await apiUpdateCommunity(community.communityId, payload);
      queryClient.setQueryData(["community", updated.slug], updated);
      void queryClient.invalidateQueries({ queryKey: ["communities"] });
      void queryClient.invalidateQueries({ queryKey: ["community-posts", community.communityId] });
      if (updated.slug !== oldSlug) {
        queryClient.removeQueries({ queryKey: ["community", oldSlug] });
        router.replace(communityScreenHref(updated.slug));
      } else {
        queryClient.setQueryData(["community", oldSlug], updated);
        setDraft(communitySettingsDraftFromProfile(updated));
      }
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Не удалось сохранить.");
    } finally {
      setSaveBusy(false);
    }
  }, [community, draft, hasChanges, queryClient, saveBusy]);

  const handlePickAvatar = useCallback(async () => {
    if (!community || avatarBusy) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert("Аватар", "Нужен доступ к галерее.");
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 1,
    });
    if (result.canceled || !result.assets[0]) return;
    setAvatarBusy(true);
    try {
      await uploadCommunityAvatarFromPickerAsset(community.communityId, result.assets[0]);
      setAvatarCacheVersion((v) => v + 1);
      await communityQuery.refetch();
      void queryClient.invalidateQueries({ queryKey: ["communities"] });
    } catch (err) {
      Alert.alert("Аватар", communityAvatarUploadErrorMessage(err));
    } finally {
      setAvatarBusy(false);
    }
  }, [avatarBusy, community, communityQuery, queryClient]);

  const handleDeleteCommunity = useCallback(async () => {
    if (!community || deleteBusy) return;
    if (deleteConfirmName.trim() !== community.name.trim()) {
      setDeleteError("Название не совпадает.");
      return;
    }
    setDeleteBusy(true);
    setDeleteError(null);
    try {
      await apiDeleteCommunity(community.communityId);
      queryClient.removeQueries({ queryKey: ["community", slug] });
      void queryClient.invalidateQueries({ queryKey: ["communities"] });
      router.replace("/(tabs)/communities");
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Не удалось удалить сообщество.");
      setDeleteBusy(false);
    }
  }, [community, deleteBusy, deleteConfirmName, queryClient]);

  if (communityQuery.isLoading) {
    return (
      <View style={[styles.centered, { paddingTop: insets.top }]}>
        <ActivityIndicator color={floraColors.greenLight} />
      </View>
    );
  }

  if (!community || community.role !== "Owner") {
    return (
      <View style={[styles.centered, { paddingTop: insets.top, paddingHorizontal: floraSpacing.grid }]}>
        <Text style={styles.errorText}>Нет доступа к настройкам этого сообщества.</Text>
        <Pressable style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backBtnText}>Назад</Text>
        </Pressable>
      </View>
    );
  }

  if (!draft) {
    return (
      <View style={[styles.centered, { paddingTop: insets.top }]}>
        <ActivityIndicator color={floraColors.greenLight} />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + floraSpacing.grid * 2 }]}
      keyboardShouldPersistTaps="handled"
    >
      <Section title="Основное">
        <Pressable
          style={({ pressed }) => [styles.avatarRow, pressed && styles.pressed]}
          onPress={() => void handlePickAvatar()}
          disabled={avatarBusy}
        >
          <FloraAvatar
            size={floraSpacing.grid * 4}
            avatarUuid={community.avatarUuid}
            displayName={draft.name}
            communityName={draft.name}
            username={draft.slug}
            seed={community.communityId}
            cacheVersion={avatarCacheVersion}
          />
          <Text style={styles.avatarHint}>{avatarBusy ? "Загрузка…" : "Изменить аватар"}</Text>
        </Pressable>

        <Field label="Название">
          <TextInput
            style={styles.input}
            value={draft.name}
            onChangeText={(name) => updateDraft({ name })}
            placeholder="Название сообщества"
            placeholderTextColor={floraColors.textMuted}
            maxLength={100}
          />
        </Field>

        <Field label="Ссылка">
          <TextInput
            style={styles.input}
            value={draft.slug}
            onChangeText={(slugValue) => updateDraft({ slug: slugValue })}
            placeholder="community-slug"
            placeholderTextColor={floraColors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {!hasOnlyCommunitySlugChars(draft.slug) && draft.slug.trim().length > 0 ? (
            <Text style={styles.fieldHint}>{COMMUNITY_SLUG_FORMAT_MESSAGE}</Text>
          ) : null}
        </Field>
      </Section>

      <Section title="Приватность">
        <View style={styles.switchRow}>
          <View style={styles.switchCopy}>
            <Text style={styles.switchTitle}>Публичное сообщество</Text>
            <Text style={styles.switchDesc}>
              Если включено — сообщество видно в поиске и рекомендациях. Если выключено — доступ только для
              участников.
            </Text>
          </View>
          <Switch
            value={!draft.isPrivate}
            onValueChange={(isPublic) => updateDraft({ isPrivate: !isPublic })}
            trackColor={{ false: floraColors.border, true: floraColors.accent }}
            thumbColor={floraColors.text}
          />
        </View>
      </Section>

      {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}
      <Pressable
        style={({ pressed }) => [
          styles.saveBtn,
          pressed && styles.pressed,
          (!hasChanges || saveBusy) && styles.saveBtnDisabled,
        ]}
        disabled={!hasChanges || saveBusy}
        onPress={() => void handleSave()}
      >
        {saveBusy ? (
          <ActivityIndicator color={floraColors.text} />
        ) : (
          <Text style={styles.saveBtnText}>Сохранить изменения</Text>
        )}
      </Pressable>

      <Section title="Опасная зона">
        <Text style={styles.dangerHint}>
          Это действие необратимо. Все участники, посты и настройки сообщества будут удалены.
        </Text>
        <Field label="Введите название для подтверждения">
          <TextInput
            style={styles.input}
            value={deleteConfirmName}
            onChangeText={(value) => {
              setDeleteConfirmName(value);
              setDeleteError(null);
            }}
            placeholder={community.name}
            placeholderTextColor={floraColors.textMuted}
          />
        </Field>
        {deleteError ? <Text style={styles.errorText}>{deleteError}</Text> : null}
        <Pressable
          style={({ pressed }) => [
            styles.dangerBtn,
            pressed && styles.pressed,
            (deleteBusy || deleteConfirmName.trim() !== community.name.trim()) && styles.saveBtnDisabled,
          ]}
          disabled={deleteBusy || deleteConfirmName.trim() !== community.name.trim()}
          onPress={() => void handleDeleteCommunity()}
        >
          {deleteBusy ? (
            <ActivityIndicator color="#f6a8a8" />
          ) : (
            <Text style={styles.dangerBtnText}>Удалить сообщество</Text>
          )}
        </Pressable>
      </Section>
    </ScrollView>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: floraColors.bg },
  content: {
    padding: floraSpacing.grid,
    gap: floraSpacing.grid,
  },
  centered: {
    flex: 1,
    backgroundColor: floraColors.bg,
    alignItems: "center",
    justifyContent: "center",
    gap: floraSpacing.grid,
  },
  section: {
    gap: floraSpacing.grid,
    padding: floraSpacing.grid,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: floraColors.border,
    backgroundColor: floraColors.surface,
  },
  sectionTitle: {
    color: floraColors.text,
    fontSize: 16,
    fontWeight: "600",
  },
  field: { gap: floraSpacing.gridFine * 2 },
  fieldLabel: {
    color: floraColors.textMuted,
    fontSize: 13,
    fontWeight: "300",
  },
  fieldHint: {
    color: floraColors.textMuted,
    fontSize: 12,
  },
  input: {
    backgroundColor: floraColors.bg,
    borderColor: floraColors.border,
    borderWidth: 1,
    borderRadius: 8,
    color: floraColors.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  avatarRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
  },
  avatarHint: {
    color: floraColors.greenLight,
    fontSize: 14,
    fontWeight: "300",
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
  },
  switchCopy: { flex: 1, gap: floraSpacing.gridFine },
  switchTitle: {
    color: floraColors.text,
    fontSize: 15,
    fontWeight: "400",
  },
  switchDesc: {
    color: floraColors.textMuted,
    fontSize: 13,
    fontWeight: "300",
    lineHeight: 18,
  },
  saveBtn: {
    backgroundColor: floraColors.accentDark,
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
  },
  saveBtnDisabled: { opacity: 0.5 },
  saveBtnText: {
    color: floraColors.text,
    fontWeight: "600",
  },
  dangerHint: {
    color: floraColors.textMuted,
    fontSize: 13,
    lineHeight: 18,
  },
  dangerBtn: {
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(246, 168, 168, 0.5)",
  },
  dangerBtnText: {
    color: "#f6a8a8",
    fontWeight: "600",
  },
  errorText: {
    color: floraColors.error,
    fontSize: 14,
    textAlign: "center",
  },
  backBtn: {
    paddingHorizontal: floraSpacing.grid * 2,
    paddingVertical: floraSpacing.grid,
    borderWidth: 1,
    borderColor: floraColors.border,
    borderRadius: 8,
  },
  backBtnText: {
    color: floraColors.text,
  },
  pressed: { opacity: 0.85 },
});

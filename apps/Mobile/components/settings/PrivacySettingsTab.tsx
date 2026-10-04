import { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { SettingsBlocklistModal } from "@/components/settings/SettingsBlocklistModal";
import { SettingsSelectField } from "@/components/settings/SettingsSelectField";
import { settingsUi as ui } from "@/components/settings/settingsUi";
import {
  MESSAGES_FROM_OPTIONS,
  ONLINE_VISIBILITY_OPTIONS,
  PRIVACY_VISIBILITY_OPTIONS,
} from "@/lib/settingsPrivacyDraft";
import { floraColors } from "@/lib/theme";
import { useSettingsDraftStore } from "@/stores/settingsDraftStore";

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase();
}

function matchesSearch(query: string, ...haystacks: readonly (string | null | undefined)[]): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  return haystacks.some((item) => (item ?? "").toLowerCase().includes(q));
}

type PrivacySettingsTabProps = {
  searchQuery: string;
};

export function PrivacySettingsTab({ searchQuery }: PrivacySettingsTabProps) {
  const privacy = useSettingsDraftStore((s) => s.privacy);
  const privacyReady = useSettingsDraftStore((s) => s.privacyReady);
  const updatePrivacy = useSettingsDraftStore((s) => s.updatePrivacy);
  const saveError = useSettingsDraftStore((s) => s.saveError);
  const saveSuccess = useSettingsDraftStore((s) => s.saveSuccess);
  const [blocklistOpen, setBlocklistOpen] = useState(false);

  const visibilityOptions = PRIVACY_VISIBILITY_OPTIONS;

  const profileVisible = matchesSearch(
    searchQuery,
    "видимость",
    "друзья",
    "подписки",
    "публикации",
    "лайки",
    "репосты",
    "профиль",
  );
  const interactionVisible = matchesSearch(
    searchQuery,
    "писать",
    "сообщения",
    "комментировать",
    "комментарии",
    "взаимодействие",
  );
  const onlineVisible = matchesSearch(searchQuery, "онлайн", "виден", "незнакомых", "друзей");
  const blocklistVisible = matchesSearch(
    searchQuery,
    "блок",
    "чёрный",
    "черный",
    "список",
    "block",
  );

  if (
    normalizeSearch(searchQuery) &&
    !profileVisible &&
    !interactionVisible &&
    !onlineVisible &&
    !blocklistVisible
  ) {
    return null;
  }

  if (!privacyReady) {
    return (
      <View style={ui.tabBody}>
        <ActivityIndicator color={floraColors.greenLight} />
      </View>
    );
  }

  return (
    <View style={ui.tabBody}>
      {saveError ? <Text style={ui.feedbackError}>{saveError}</Text> : null}
      {saveSuccess ? <Text style={ui.feedbackSuccess}>{saveSuccess}</Text> : null}

      {profileVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Видимость профиля</Text>
          <View style={ui.fieldsStack}>
            <SettingsSelectField
              label="Кто видит моих друзей"
              value={privacy.friendsVisibility}
              options={visibilityOptions}
              onChange={(friendsVisibility) => updatePrivacy({ friendsVisibility })}
            />
            <SettingsSelectField
              label="Кто видит мои подписки"
              value={privacy.subscriptionsVisibility}
              options={visibilityOptions}
              onChange={(subscriptionsVisibility) => updatePrivacy({ subscriptionsVisibility })}
            />
            <SettingsSelectField
              label="Кто видит мои публикации"
              value={privacy.postsVisibility}
              options={visibilityOptions}
              onChange={(postsVisibility) => updatePrivacy({ postsVisibility })}
            />
            <SettingsSelectField
              label="Кто видит мои лайки"
              value={privacy.likesVisibility}
              options={visibilityOptions}
              onChange={(likesVisibility) => updatePrivacy({ likesVisibility })}
            />
            <SettingsSelectField
              label="Кто видит мои репосты"
              value={privacy.repostsVisibility}
              options={visibilityOptions}
              onChange={(repostsVisibility) => updatePrivacy({ repostsVisibility })}
            />
          </View>
        </View>
      ) : null}

      {interactionVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Взаимодействие</Text>
          <View style={ui.fieldsStack}>
            <SettingsSelectField
              label="Кто может мне писать"
              value={privacy.messagesFrom}
              options={MESSAGES_FROM_OPTIONS}
              onChange={(messagesFrom) => updatePrivacy({ messagesFrom })}
            />
            <SettingsSelectField
              label="Кто может комментировать мои посты"
              value={privacy.commentsFrom}
              options={visibilityOptions}
              onChange={(commentsFrom) => updatePrivacy({ commentsFrom })}
            />
          </View>
        </View>
      ) : null}

      {onlineVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Видимость онлайна</Text>
          <View style={ui.fieldsStack}>
            <SettingsSelectField
              label="Для друзей"
              value={privacy.onlineFriends}
              options={ONLINE_VISIBILITY_OPTIONS}
              onChange={(onlineFriends) => updatePrivacy({ onlineFriends })}
            />
            <SettingsSelectField
              label="Для незнакомых"
              value={privacy.onlineStrangers}
              options={ONLINE_VISIBILITY_OPTIONS}
              onChange={(onlineStrangers) => updatePrivacy({ onlineStrangers })}
            />
          </View>
        </View>
      ) : null}

      {blocklistVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Чёрный список</Text>
          <View style={ui.fieldsStack}>
            <Text style={ui.listCardDesc}>
              Пользователи из чёрного списка не смогут просматривать ваш профиль и писать вам
              сообщения.
            </Text>
            <Pressable
              style={({ pressed }) => [ui.textAction, pressed && ui.pressed]}
              onPress={() => setBlocklistOpen(true)}
            >
              <Text style={ui.textActionPrimary}>Управление чёрным списком</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <SettingsBlocklistModal visible={blocklistOpen} onClose={() => setBlocklistOpen(false)} />
    </View>
  );
}

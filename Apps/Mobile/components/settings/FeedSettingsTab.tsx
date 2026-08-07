import { apiClearNotInterested, isApiRequestError } from "@flora/client-core/api";
import { useState } from "react";
import { ActivityIndicator, Pressable, Switch, Text, View } from "react-native";
import { SettingsFeedHiddenModal } from "@/components/settings/SettingsFeedHiddenModal";
import { SettingsSelectField } from "@/components/settings/SettingsSelectField";
import { settingsUi as ui } from "@/components/settings/settingsUi";
import {
  FEED_AUTHOR_DIVERSITY_OPTIONS,
  FEED_EXPLORATION_OPTIONS,
  FEED_FRESHNESS_OPTIONS,
  FEED_SEEN_POSTS_OPTIONS,
} from "@/lib/settingsFeedDraft";
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

type Props = {
  searchQuery: string;
};

function ToggleCard({
  title,
  description,
  value,
  onValueChange,
}: {
  title: string;
  description: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
}) {
  return (
    <View style={ui.listCard}>
      <View style={ui.listCardInfo}>
        <Text style={ui.listCardTitle}>{title}</Text>
        <Text style={ui.listCardDesc}>{description}</Text>
      </View>
      <View style={ui.listCardActionCol}>
        <Switch
          value={value}
          onValueChange={onValueChange}
          trackColor={{ false: floraColors.surface, true: floraColors.accentDark }}
          thumbColor={floraColors.whiteTemplate}
        />
      </View>
    </View>
  );
}

export function FeedSettingsTab({ searchQuery }: Props) {
  const feed = useSettingsDraftStore((s) => s.feed);
  const feedReady = useSettingsDraftStore((s) => s.feedReady);
  const updateFeed = useSettingsDraftStore((s) => s.updateFeed);
  const clearSaveFeedback = useSettingsDraftStore((s) => s.clearSaveFeedback);
  const saveError = useSettingsDraftStore((s) => s.saveError);
  const saveSuccess = useSettingsDraftStore((s) => s.saveSuccess);

  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [clearState, setClearState] = useState<"idle" | "busy" | "done">("idle");
  const [clearError, setClearError] = useState<string | null>(null);

  const patch = (next: Partial<typeof feed>) => {
    clearSaveFeedback();
    updateFeed(next);
  };

  const handleClearNotInterested = async () => {
    setClearState("busy");
    setClearError(null);
    try {
      await apiClearNotInterested();
      setClearState("done");
    } catch (e) {
      setClearError(
        isApiRequestError(e) || e instanceof Error ? e.message : "Не удалось сбросить отметки",
      );
      setClearState("idle");
    }
  };

  const recommendationsVisible = matchesSearch(
    searchQuery,
    "рекоменд",
    "свежест",
    "открыт",
    "разнообраз",
    "автор",
    "просмотр",
    "лента",
  );
  const contentVisible = matchesSearch(
    searchQuery,
    "репост",
    "сообществ",
    "содержим",
    "лента",
  );
  const hiddenVisible = matchesSearch(
    searchQuery,
    "скрыт",
    "интересно",
    "автор",
    "сообществ",
    "не интересно",
  );

  if (
    normalizeSearch(searchQuery) &&
    !recommendationsVisible &&
    !contentVisible &&
    !hiddenVisible
  ) {
    return null;
  }

  if (!feedReady) {
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

      {recommendationsVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Рекомендации</Text>
          <View style={ui.fieldsStack}>
            <SettingsSelectField
              label="Баланс свежести"
              value={feed.freshness}
              options={FEED_FRESHNESS_OPTIONS}
              onChange={(freshness) => patch({ freshness })}
            />
            <SettingsSelectField
              label="Открытие нового"
              value={feed.exploration}
              options={FEED_EXPLORATION_OPTIONS}
              onChange={(exploration) => patch({ exploration })}
            />
            <SettingsSelectField
              label="Разнообразие авторов"
              value={feed.authorDiversity}
              options={FEED_AUTHOR_DIVERSITY_OPTIONS}
              onChange={(authorDiversity) => patch({ authorDiversity })}
            />
            <SettingsSelectField
              label="Просмотренные посты"
              value={feed.seenPosts}
              options={FEED_SEEN_POSTS_OPTIONS}
              onChange={(seenPosts) => patch({ seenPosts })}
            />
          </View>
        </View>
      ) : null}

      {contentVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Содержимое ленты</Text>
          <View style={ui.fieldsStack}>
            <ToggleCard
              title="Репосты"
              description="Показывать репосты в рекомендациях и подписках"
              value={feed.showReposts}
              onValueChange={(showReposts) => patch({ showReposts })}
            />
            <ToggleCard
              title="Посты сообществ"
              description="Показывать посты сообществ в рекомендациях"
              value={feed.communityPosts}
              onValueChange={(communityPosts) => patch({ communityPosts })}
            />
          </View>
        </View>
      ) : null}

      {hiddenVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Скрытое и «не интересно»</Text>
          <View style={ui.fieldsStack}>
            <Text style={ui.sectionHint}>
              Скрытые авторы и сообщества не попадают в рекомендации. Отметки «не интересно» мягко
              снижают похожие посты в ленте.
            </Text>
            <View style={ui.formActionsRow}>
              <Pressable
                style={({ pressed }) => [ui.softMutedButton, pressed && ui.pressed]}
                onPress={() => setHiddenOpen(true)}
              >
                <Text style={ui.softMutedButtonText}>Скрытые авторы и сообщества</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  ui.softMutedButton,
                  (pressed || clearState !== "idle") && ui.pressed,
                  clearState !== "idle" && ui.textActionDisabled,
                ]}
                onPress={() => void handleClearNotInterested()}
                disabled={clearState !== "idle"}
              >
                {clearState === "busy" ? (
                  <ActivityIndicator color={floraColors.gray} />
                ) : (
                  <Text style={ui.softMutedButtonText}>
                    {clearState === "done"
                      ? "Отметки сброшены"
                      : "Сбросить отметки «не интересно»"}
                  </Text>
                )}
              </Pressable>
            </View>
            {clearError ? <Text style={ui.feedbackError}>{clearError}</Text> : null}
          </View>
        </View>
      ) : null}

      <SettingsFeedHiddenModal visible={hiddenOpen} onClose={() => setHiddenOpen(false)} />
    </View>
  );
}

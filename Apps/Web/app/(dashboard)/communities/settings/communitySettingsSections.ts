export type CommunitySettingsSectionId = "general" | "privacy" | "danger";

export type CommunitySettingsSection = {
  id: CommunitySettingsSectionId;
  label: string;
  description: string;
};

export const COMMUNITY_SETTINGS_SECTIONS: readonly CommunitySettingsSection[] = [
  {
    id: "general",
    label: "Основное",
    description: "Название, ссылка и оформление сообщества.",
  },
  {
    id: "privacy",
    label: "Приватность",
    description: "Кто может найти и подписаться на сообщество.",
  },
  {
    id: "danger",
    label: "Опасная зона",
    description: "Удаление сообщества.",
  },
] as const;

export const DEFAULT_COMMUNITY_SETTINGS_SECTION: CommunitySettingsSectionId = "general";

export function parseCommunitySettingsSectionId(
  value: string | null | undefined,
): CommunitySettingsSectionId | null {
  if (!value) return null;
  if (value === "appearance") return "general";
  return COMMUNITY_SETTINGS_SECTIONS.some((section) => section.id === value)
    ? (value as CommunitySettingsSectionId)
    : null;
}

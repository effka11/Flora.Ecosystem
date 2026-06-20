export type SettingsSectionId =
  | "account"
  | "privacy"
  | "security"
  | "notifications"
  | "customization";

export type SettingsSection = {
  id: SettingsSectionId;
  label: string;
  description: string;
};

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "account",
    label: "Аккаунт",
    description: "Имя, никнейм, почта и параметры профиля.",
  },
  {
    id: "privacy",
    label: "Приватность",
    description: "Кто видит профиль, статус и переписки.",
  },
  {
    id: "security",
    label: "Безопасность",
    description: "Пароль, сессии и двухфакторная аутентификация.",
  },
  {
    id: "notifications",
    label: "Уведомления",
    description: "Push, почта и оповещения в приложении.",
  },
  {
    id: "customization",
    label: "Кастомизация",
    description: "Тема, язык и оформление интерфейса.",
  },
] as const;

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "account";

export function parseSettingsSectionId(value: string | null | undefined): SettingsSectionId | null {
  if (!value) return null;
  return SETTINGS_SECTIONS.some((section) => section.id === value) ? (value as SettingsSectionId) : null;
}

export function settingsSectionIndex(id: SettingsSectionId): number {
  const idx = SETTINGS_SECTIONS.findIndex((section) => section.id === id);
  return idx >= 0 ? idx : 0;
}

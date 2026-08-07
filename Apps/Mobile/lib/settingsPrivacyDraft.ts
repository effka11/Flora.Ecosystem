export {
  defaultPrivacyDraft,
  privacyDraftEqual,
  privacyDraftFromApi,
  type MessagesFrom,
  type OnlineVisibility,
  type PrivacyVisibility,
  type SettingsPrivacyDraft,
} from "@flora/client-core/auth";

import type { MessagesFrom, OnlineVisibility, PrivacyVisibility } from "@flora/client-core/auth";

export const PRIVACY_VISIBILITY_OPTIONS: readonly { value: PrivacyVisibility; label: string }[] = [
  { value: "all", label: "Все пользователи" },
  { value: "friends", label: "Только друзья" },
  { value: "none", label: "Никто" },
] as const;

export const MESSAGES_FROM_OPTIONS: readonly { value: MessagesFrom; label: string }[] = [
  { value: "all", label: "Все пользователи" },
  { value: "friends", label: "Только друзья" },
] as const;

export const ONLINE_VISIBILITY_OPTIONS: readonly { value: OnlineVisibility; label: string }[] = [
  { value: "visible", label: "Виден" },
  { value: "hidden", label: "Не виден" },
] as const;

export function labelForPrivacyOption<T extends string>(
  options: readonly { value: T; label: string }[],
  value: T,
): string {
  return options.find((item) => item.value === value)?.label ?? value;
}

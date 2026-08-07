/** Shared privacy settings draft (Apps/Web + Apps/Mobile). */

export type PrivacyVisibility = "all" | "friends" | "none";
export type OnlineVisibility = "visible" | "hidden";
export type MessagesFrom = "all" | "friends";

export type SettingsPrivacyDraft = {
  friendsVisibility: PrivacyVisibility;
  subscriptionsVisibility: PrivacyVisibility;
  postsVisibility: PrivacyVisibility;
  likesVisibility: PrivacyVisibility;
  repostsVisibility: PrivacyVisibility;
  messagesFrom: MessagesFrom;
  commentsFrom: PrivacyVisibility;
  onlineFriends: OnlineVisibility;
  onlineStrangers: OnlineVisibility;
};

const DEFAULT_PRIVACY: SettingsPrivacyDraft = {
  friendsVisibility: "all",
  subscriptionsVisibility: "all",
  postsVisibility: "all",
  likesVisibility: "friends",
  repostsVisibility: "all",
  messagesFrom: "all",
  commentsFrom: "all",
  onlineFriends: "visible",
  onlineStrangers: "hidden",
};

export function defaultPrivacyDraft(): SettingsPrivacyDraft {
  return { ...DEFAULT_PRIVACY };
}

function parsePrivacyVisibility(value: unknown, fallback: PrivacyVisibility): PrivacyVisibility {
  if (value === "all" || value === "friends" || value === "none") return value;
  return fallback;
}

function parseMessagesFrom(value: unknown, fallback: MessagesFrom): MessagesFrom {
  if (value === "all" || value === "friends") return value;
  return fallback;
}

function parseOnlineVisibility(value: unknown, fallback: OnlineVisibility): OnlineVisibility {
  if (value === "visible" || value === "hidden") return value;
  return fallback;
}

export function privacyDraftFromApi(raw: unknown): SettingsPrivacyDraft {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    friendsVisibility: parsePrivacyVisibility(source.friendsVisibility, DEFAULT_PRIVACY.friendsVisibility),
    subscriptionsVisibility: parsePrivacyVisibility(
      source.subscriptionsVisibility,
      DEFAULT_PRIVACY.subscriptionsVisibility,
    ),
    postsVisibility: parsePrivacyVisibility(source.postsVisibility, DEFAULT_PRIVACY.postsVisibility),
    likesVisibility: parsePrivacyVisibility(source.likesVisibility, DEFAULT_PRIVACY.likesVisibility),
    repostsVisibility: parsePrivacyVisibility(source.repostsVisibility, DEFAULT_PRIVACY.repostsVisibility),
    messagesFrom: parseMessagesFrom(source.messagesFrom, DEFAULT_PRIVACY.messagesFrom),
    commentsFrom: parsePrivacyVisibility(source.commentsFrom, DEFAULT_PRIVACY.commentsFrom),
    onlineFriends: parseOnlineVisibility(source.onlineFriends, DEFAULT_PRIVACY.onlineFriends),
    onlineStrangers: parseOnlineVisibility(source.onlineStrangers, DEFAULT_PRIVACY.onlineStrangers),
  };
}

export function privacyDraftToApiPayload(draft: SettingsPrivacyDraft): SettingsPrivacyDraft {
  return { ...draft };
}

export function privacyDraftEqual(a: SettingsPrivacyDraft, b: SettingsPrivacyDraft): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

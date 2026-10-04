export type NotificationEventKey =
  | "messages"
  | "mentions"
  | "friendRequests"
  | "likes"
  | "friendPosts"
  | "communityInvites";

export type NotificationChannelKey = "inApp" | "push" | "email";

export type NotificationEventRow = Record<NotificationChannelKey, boolean>;

export type NotificationEventMatrix = Record<NotificationEventKey, NotificationEventRow>;

export type SettingsNotificationsDraft = {
  pushEnabled: boolean;
  emailEnabled: boolean;
  quietMode: boolean;
  quietFrom: string;
  quietTo: string;
  quietAllowImportant: boolean;
  events: NotificationEventMatrix;
};

export const NOTIFICATION_EVENT_ROWS: readonly {
  key: NotificationEventKey;
  label: string;
}[] = [
  { key: "messages", label: "Личные сообщения" },
  { key: "mentions", label: "Упоминания (@никнейм)" },
  { key: "friendRequests", label: "Заявки в друзья" },
  { key: "likes", label: "Лайки и реакции" },
  { key: "friendPosts", label: "Новые посты друзей" },
  { key: "communityInvites", label: "Приглашения в сообщества" },
] as const;

export const NOTIFICATION_CHANNEL_COLS: readonly {
  key: NotificationChannelKey;
  label: string;
}[] = [
  { key: "inApp", label: "В приложении" },
  { key: "push", label: "Push" },
  { key: "email", label: "Email" },
] as const;

function defaultEvents(): NotificationEventMatrix {
  return {
    messages: { inApp: true, push: true, email: true },
    mentions: { inApp: true, push: true, email: true },
    friendRequests: { inApp: true, push: true, email: true },
    likes: { inApp: true, push: true, email: false },
    friendPosts: { inApp: true, push: false, email: false },
    communityInvites: { inApp: true, push: true, email: true },
  };
}

export function defaultNotificationsDraft(): SettingsNotificationsDraft {
  return {
    pushEnabled: true,
    emailEnabled: true,
    quietMode: false,
    quietFrom: "23:00",
    quietTo: "08:00",
    quietAllowImportant: true,
    events: defaultEvents(),
  };
}

function parseTime(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!/^\d{2}:\d{2}$/.test(trimmed)) return fallback;
  const [h, m] = trimmed.split(":").map((part) => Number.parseInt(part, 10));
  if (
    Number.isNaN(h) ||
    Number.isNaN(m) ||
    h < 0 ||
    h > 23 ||
    m < 0 ||
    m > 59
  ) {
    return fallback;
  }
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function parseEventRow(raw: unknown, fallback: NotificationEventRow): NotificationEventRow {
  if (!raw || typeof raw !== "object") return { ...fallback };
  const source = raw as Record<string, unknown>;
  return {
    inApp: typeof source.inApp === "boolean" ? source.inApp : fallback.inApp,
    push: typeof source.push === "boolean" ? source.push : fallback.push,
    email: typeof source.email === "boolean" ? source.email : fallback.email,
  };
}

export function normalizeNotificationsDraft(
  raw: Partial<SettingsNotificationsDraft> | null | undefined,
): SettingsNotificationsDraft {
  const base = defaultNotificationsDraft();
  if (!raw) return base;
  const eventsSource =
    raw.events && typeof raw.events === "object"
      ? (raw.events as Partial<NotificationEventMatrix>)
      : {};
  const events = defaultEvents();
  for (const { key } of NOTIFICATION_EVENT_ROWS) {
    events[key] = parseEventRow(eventsSource[key], events[key]!);
  }
  return {
    pushEnabled: typeof raw.pushEnabled === "boolean" ? raw.pushEnabled : base.pushEnabled,
    emailEnabled: typeof raw.emailEnabled === "boolean" ? raw.emailEnabled : base.emailEnabled,
    quietMode: typeof raw.quietMode === "boolean" ? raw.quietMode : base.quietMode,
    quietFrom: parseTime(raw.quietFrom, base.quietFrom),
    quietTo: parseTime(raw.quietTo, base.quietTo),
    quietAllowImportant:
      typeof raw.quietAllowImportant === "boolean"
        ? raw.quietAllowImportant
        : base.quietAllowImportant,
    events,
  };
}

export function notificationsDraftEqual(
  a: SettingsNotificationsDraft,
  b: SettingsNotificationsDraft,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Нормализует ввод времени к HH:MM по мере набора. */
export function maskQuietTimeInput(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}:${digits.slice(2)}`;
}

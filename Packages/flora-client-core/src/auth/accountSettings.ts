/** Shared account settings draft helpers (Apps/Web + Apps/Mobile). */

export type SettingsAccountDraft = {
  displayName: string;
  username: string;
  birthDate: string;
  status: string;
};

const USERNAME_RE = /^[a-z0-9_]{3,50}$/;

export type AccountDraftMeSource = {
  displayName?: string | null;
  username?: string | null;
  birthDate?: string | null;
  status?: string | null;
};

export function emptyAccountDraft(): SettingsAccountDraft {
  return {
    displayName: "",
    username: "",
    birthDate: "",
    status: "",
  };
}

export function accountDraftFromMe(me: AccountDraftMeSource | null | undefined): SettingsAccountDraft {
  if (!me) return emptyAccountDraft();
  return {
    displayName: (me.displayName ?? "").trim(),
    username: (me.username ?? "").trim().replace(/^@+/, "").toLowerCase(),
    birthDate: (me.birthDate ?? "").trim(),
    status: (me.status ?? "").trim(),
  };
}

export function accountDraftEqual(a: SettingsAccountDraft, b: SettingsAccountDraft): boolean {
  return (
    a.displayName.trim() === b.displayName.trim() &&
    a.username.trim().replace(/^@+/, "").toLowerCase() ===
      b.username.trim().replace(/^@+/, "").toLowerCase() &&
    a.birthDate.trim() === b.birthDate.trim() &&
    a.status.trim() === b.status.trim()
  );
}

/** Base validation shared by Apps; Web may add reserved-username / status rules on top. */
export function validateAccountDraft(draft: SettingsAccountDraft): string | null {
  const name = draft.displayName.trim();
  const nick = draft.username.trim().replace(/^@+/, "").toLowerCase();
  const statusNorm = draft.status.trim();

  if (!name) return "Введите имя.";
  if (!USERNAME_RE.test(nick)) {
    return "Никнейм: 3–50 символов, только строчная латиница, цифры и подчёркивание.";
  }
  if (statusNorm.length > 150) return "Статус не более 150 символов.";
  return null;
}

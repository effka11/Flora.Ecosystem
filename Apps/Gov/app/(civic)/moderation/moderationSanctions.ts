/** Local civic draft wired to Messaging resolve `accountBlock`. */
export const ACCOUNT_BLOCK_LABEL = "Блокировка аккаунта";

export type AccountBlockMode = "none" | "timed" | "forever";

export type SanctionDraft = {
  mode: AccountBlockMode;
  daysText: string;
};

export type FrankingAccountBlockRequest = {
  days?: number;
};
export function emptySanctionDraft(): SanctionDraft {
  return { mode: "none", daysText: "" };
}

/** 1–9999 whole days. Leading zeros and zero itself are invalid. */
export function parseBlockDays(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[1-9]\d{0,3}$/.test(trimmed)) return null;
  return Number(trimmed);
}

export function hasSelectedSanctions(draft: SanctionDraft): boolean {
  if (draft.mode === "forever") return true;
  return draft.mode === "timed" && parseBlockDays(draft.daysText) !== null;
}

/** Maps moderator draft to resolve `accountBlock`; `undefined` omits the key (no ban). */
export function sanctionDraftToAccountBlock(
  draft: SanctionDraft,
): FrankingAccountBlockRequest | undefined {
  if (draft.mode === "none") return undefined;
  if (draft.mode === "forever") return {};
  const days = parseBlockDays(draft.daysText);
  if (days === null) return undefined;
  return { days };
}

/** Second click on the same mode clears the choice. */
export function setAccountBlockMode(
  draft: SanctionDraft,
  mode: Exclude<AccountBlockMode, "none">,
): SanctionDraft {
  if (draft.mode === mode) {
    return { ...draft, mode: "none" };
  }
  return { ...draft, mode };
}

export function setAccountBlockDays(draft: SanctionDraft, daysText: string): SanctionDraft {
  const next = daysText.replace(/\D/g, "").slice(0, 4);
  return { mode: "timed", daysText: next };
}

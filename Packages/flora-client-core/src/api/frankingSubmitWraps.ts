import type { FrankingWrapTargetDto } from "../contracts/franking.js";

/** Live viewer-account cap (franking.md §4.7). Reporter backup wraps do not count. */
export const FRANKING_MAX_VIEWER_ACCOUNTS = 5;

function sameUuid(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function selectFrankingSubmitWrapTargets(input: {
  ownItems: readonly FrankingWrapTargetDto[];
  reviewerItems: readonly FrankingWrapTargetDto[];
  reporterUserUuid: string;
  accusedUserUuid: string;
  maxViewerAccounts?: number;
}): { backup: FrankingWrapTargetDto[]; viewers: FrankingWrapTargetDto[] } {
  const reporter = input.reporterUserUuid.trim();
  const accused = input.accusedUserUuid.trim();
  const max = input.maxViewerAccounts ?? FRANKING_MAX_VIEWER_ACCOUNTS;
  const backup = input.ownItems.filter((item) => sameUuid(item.userUuid, reporter));
  const chosenUsers = new Set<string>();
  const viewers: FrankingWrapTargetDto[] = [];
  for (const item of input.reviewerItems) {
    if (sameUuid(item.userUuid, reporter) || sameUuid(item.userUuid, accused)) continue;
    const user = item.userUuid.trim().toLowerCase();
    if (!chosenUsers.has(user)) {
      if (chosenUsers.size >= max) continue;
      chosenUsers.add(user);
    }
    viewers.push(item);
  }
  return { backup, viewers };
}

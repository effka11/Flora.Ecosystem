/**
 * Счётчик лайков/репостов: лента — источник истины, оверлей мутации не должен
 * замораживать старое «1» после того, как сервер уже отдал новый тотал.
 */
export function mergeEngagementCount(
  postCount: number,
  postFlag: boolean,
  overrideFlag: boolean | undefined,
  overrideCount: number | undefined,
): number {
  if (overrideFlag === undefined) return postCount;
  if (overrideFlag === postFlag) return Math.max(postCount, overrideCount ?? 0);
  if (overrideCount != null) return overrideCount;
  return Math.max(0, postCount + (overrideFlag ? 1 : -1));
}

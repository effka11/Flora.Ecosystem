export function threadInvalidateKeys(
  conversationUuid: string,
  kind?: "dm" | "groupChat" | null,
): readonly (readonly string[])[] {
  if (kind === "groupChat") return [["group-messages", conversationUuid]];
  if (kind === "dm") return [["messages", conversationUuid]];
  return [
    ["messages", conversationUuid],
    ["group-messages", conversationUuid],
  ];
}

/** Пометить страницу треда устаревшей, не запуская refetch неактивного query. */
export function invalidateThreadForRealtime(
  client: {
    invalidateQueries: (opts: {
      queryKey: readonly unknown[];
      refetchType: "none";
    }) => unknown;
  },
  conversationUuid: string,
  kind?: "dm" | "groupChat" | null,
): void {
  for (const queryKey of threadInvalidateKeys(conversationUuid, kind)) {
    void client.invalidateQueries({ queryKey, refetchType: "none" });
  }
}

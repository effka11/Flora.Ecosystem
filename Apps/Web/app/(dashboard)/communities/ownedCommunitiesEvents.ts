export const OWNED_COMMUNITIES_CHANGED_EVENT = "flora:owned-communities-changed";

export function notifyOwnedCommunitiesChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OWNED_COMMUNITIES_CHANGED_EVENT));
}

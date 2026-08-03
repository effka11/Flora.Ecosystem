import { authFetch } from "../api/client.js";
import { asRecord, readStr } from "../contracts/parse.js";

export const PRESENCE_MAX_WATCH = 100;
export const PRESENCE_HEARTBEAT_MS = 2000;
export const PRESENCE_BACKGROUND_STOP_DEBOUNCE_MS = 800;
/** Ignore transient active blips (e.g. Android push wake) before heartbeating. */
export const PRESENCE_FOREGROUND_CONFIRM_MS = 800;
/** Re-PUT watch well under server WATCH_TTL (5 min). */
export const PRESENCE_WATCH_REFRESH_MS = 2 * 60 * 1000;

/** Surface keys checked first when merging watch sets (cap 100). */
const SURFACE_PRIORITY = [
  "messages",
  "messages-list",
  "chat-header",
  "public-profile",
  "people",
] as const;

export type PresenceSnapshot = {
  userUuid: string;
  isOnline: boolean;
  lastSeenAt: string | null;
};

type SurfaceKey = string;

type Listener = () => void;

function parseSnapshot(raw: unknown): PresenceSnapshot | null {
  const o = asRecord(raw);
  if (!o) return null;
  const userUuid = readStr(o, ["userUuid", "UserUuid"]);
  if (!userUuid) return null;
  const onlineRaw = o.isOnline ?? o.IsOnline;
  const isOnline = onlineRaw === true || onlineRaw === "true";
  const lastSeenAt = readStr(o, ["lastSeenAt", "LastSeenAt"]) || null;
  return { userUuid, isOnline, lastSeenAt };
}

/**
 * True when `snap` should replace `prev`.
 * Privacy-denied snapshots (`isOnline: false` without lastSeen) always win so a
 * hidden peer cannot stay "online" after GET/SSE hide.
 */
function shouldApply(snap: PresenceSnapshot, prev: PresenceSnapshot): boolean {
  if (!snap.isOnline && !snap.lastSeenAt) {
    return prev.isOnline || prev.lastSeenAt != null;
  }
  if (snap.lastSeenAt && prev.lastSeenAt) {
    if (snap.lastSeenAt < prev.lastSeenAt) return false;
    if (snap.lastSeenAt > prev.lastSeenAt) return true;
    return snap.isOnline !== prev.isOnline;
  }
  if (snap.lastSeenAt && !prev.lastSeenAt) return true;
  if (!snap.lastSeenAt && prev.lastSeenAt) {
    return false;
  }
  return snap.isOnline !== prev.isOnline;
}

export class PresenceStore {
  private byUser = new Map<string, PresenceSnapshot>();
  private surfaces = new Map<SurfaceKey, Set<string>>();
  private connectionId: string | null = null;
  /** After logout clear(), ignore registerSurface until a new SSE connected. */
  private acceptSurfaces = true;
  /** Bumps on clear / new connected so UI effects re-bind surfaces. */
  private sessionEpoch = 0;
  private watchTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  get(userUuid: string): PresenceSnapshot | undefined {
    return this.byUser.get(userUuid);
  }

  setConnectionId(connectionId: string | null): void {
    this.connectionId = connectionId;
    if (connectionId) {
      const wasBlocked = !this.acceptSurfaces;
      this.acceptSurfaces = true;
      if (wasBlocked) this.sessionEpoch += 1;
      this.scheduleWatchSync();
      this.ensureWatchRefresh();
      if (wasBlocked) this.emit();
    } else {
      this.stopWatchRefresh();
    }
  }

  getConnectionId(): string | null {
    return this.connectionId;
  }

  /** True when surfaces may be registered (false between logout clear and next connected). */
  get surfacesAccepted(): boolean {
    return this.acceptSurfaces;
  }

  /** Changes on logout clear and when surfaces are re-armed after connected. */
  getSessionEpoch(): number {
    return this.sessionEpoch;
  }

  applySnapshot(snap: PresenceSnapshot): void {
    const prev = this.byUser.get(snap.userUuid);
    if (prev && !shouldApply(snap, prev)) return;
    this.byUser.set(snap.userUuid, snap);
    this.emit();
  }

  applyMany(items: PresenceSnapshot[]): void {
    let changed = false;
    for (const item of items) {
      const prev = this.byUser.get(item.userUuid);
      if (prev && !shouldApply(item, prev)) continue;
      this.byUser.set(item.userUuid, item);
      changed = true;
    }
    if (changed) this.emit();
  }

  /**
   * Online flag comes only from PresenceStore (SSE / GET presence).
   * DTO `isOnline` is ignored. Newer DTO `lastSeenAt` may update the "was online" text
   * while the online badge still follows the store snap.
   */
  overlayOnline(
    userUuid: string,
    _dtoOnline: boolean,
    dtoLastSeen: string | null | undefined,
  ): { isOnline: boolean; lastSeenAt: string | null } {
    const snap = this.byUser.get(userUuid);
    if (!snap) {
      return { isOnline: false, lastSeenAt: dtoLastSeen ?? null };
    }
    if (!snap.isOnline && !snap.lastSeenAt) {
      return { isOnline: false, lastSeenAt: null };
    }
    const lastSeenAt =
      dtoLastSeen && (!snap.lastSeenAt || dtoLastSeen > snap.lastSeenAt)
        ? dtoLastSeen
        : snap.lastSeenAt;
    return { isOnline: snap.isOnline, lastSeenAt };
  }

  registerSurface(key: SurfaceKey, userUuids: string[]): void {
    if (!this.acceptSurfaces) return;
    const set = new Set(userUuids.filter((u) => !!u).slice(0, PRESENCE_MAX_WATCH));
    this.surfaces.set(key, set);
    this.scheduleWatchSync();
    this.ensureWatchRefresh();
  }

  unregisterSurface(key: SurfaceKey): void {
    if (!this.surfaces.has(key)) return;
    this.surfaces.delete(key);
    this.scheduleWatchSync();
    if (this.surfaces.size === 0) this.stopWatchRefresh();
  }

  mergedWatchUuids(): string[] {
    const out = new Set<string>();
    const addFrom = (set: Set<string>) => {
      for (const u of set) {
        out.add(u);
        if (out.size >= PRESENCE_MAX_WATCH) return;
      }
    };
    for (const key of SURFACE_PRIORITY) {
      const set = this.surfaces.get(key);
      if (set) addFrom(set);
      if (out.size >= PRESENCE_MAX_WATCH) return [...out];
    }
    for (const [key, set] of this.surfaces) {
      if ((SURFACE_PRIORITY as readonly string[]).includes(key)) continue;
      addFrom(set);
      if (out.size >= PRESENCE_MAX_WATCH) break;
    }
    return [...out];
  }

  private scheduleWatchSync(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.syncWatch();
    }, 250);
  }

  private ensureWatchRefresh(): void {
    if (this.refreshTimer) return;
    if (!this.connectionId || this.surfaces.size === 0) return;
    this.refreshTimer = setInterval(() => {
      void this.syncWatch();
      // Privacy/block can change without a presence transition; GET re-applies hide.
      void this.resyncSnapshots().catch(() => {});
    }, PRESENCE_WATCH_REFRESH_MS);
  }

  private stopWatchRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  async syncWatch(): Promise<void> {
    const connectionId = this.connectionId;
    if (!connectionId) return;
    const uuids = this.mergedWatchUuids();
    await apiPresenceWatch(connectionId, uuids);
  }

  async resyncSnapshots(): Promise<void> {
    const uuids = this.mergedWatchUuids();
    if (uuids.length === 0) return;
    const items = await apiGetPresence(uuids);
    this.applyMany(items);
  }

  clear(): void {
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    this.stopWatchRefresh();
    this.byUser.clear();
    this.surfaces.clear();
    this.connectionId = null;
    this.acceptSurfaces = false;
    this.sessionEpoch += 1;
    this.emit();
  }
}

export const sharedPresenceStore = new PresenceStore();

export async function apiPresenceHeartbeat(): Promise<void> {
  const res = await authFetch("/api/auth/presence/heartbeat", { method: "POST" });
  if (!res.ok && res.status !== 204) {
    throw new Error(`presence heartbeat HTTP ${res.status}`);
  }
}

export async function apiPresenceWatch(connectionId: string, userUuids: string[]): Promise<void> {
  // POST: edge CDN rejects PUT with nginx 405 (same pattern as /api/chat-organizer).
  const res = await authFetch("/api/auth/presence/watch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      connectionId,
      userUuids: userUuids.slice(0, PRESENCE_MAX_WATCH),
    }),
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`presence watch HTTP ${res.status}`);
  }
}

export async function apiGetPresence(userUuids: string[]): Promise<PresenceSnapshot[]> {
  if (userUuids.length === 0) return [];
  const q = encodeURIComponent(userUuids.slice(0, PRESENCE_MAX_WATCH).join(","));
  const res = await authFetch(`/api/auth/presence?uuids=${q}`);
  if (!res.ok) throw new Error(`presence get HTTP ${res.status}`);
  const json: unknown = await res.json();
  const root = asRecord(json);
  const items = Array.isArray(root?.items) ? root.items : Array.isArray(json) ? json : [];
  const out: PresenceSnapshot[] = [];
  for (const item of items) {
    const snap = parseSnapshot(item);
    if (snap) out.push(snap);
  }
  return out;
}

export async function apiPostTyping(
  conversationUuid: string,
  isTyping: boolean,
  otherUserUuid?: string | null,
): Promise<void> {
  const q = otherUserUuid
    ? `?otherUserUuid=${encodeURIComponent(otherUserUuid)}`
    : "";
  const res = await authFetch(`/api/messaging/conversations/${conversationUuid}/typing${q}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isTyping }),
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`typing HTTP ${res.status}`);
  }
}

/** Start foreground heartbeat; returns stop(). Caller should invoke onVisibilityChange. */
export function startPresenceHeartbeat(options?: {
  enabled?: () => boolean;
  isVisible?: () => boolean;
}): { stop: () => void; onVisibilityChange: () => void } {
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  let backgroundTimer: ReturnType<typeof setTimeout> | null = null;
  let foregroundTimer: ReturnType<typeof setTimeout> | null = null;

  const tick = () => {
    if (stopped) return;
    if (options?.enabled && !options.enabled()) return;
    if (options?.isVisible && !options.isVisible()) return;
    void apiPresenceHeartbeat().catch(() => {});
  };

  const startInterval = () => {
    if (interval || stopped) return;
    tick();
    interval = setInterval(tick, PRESENCE_HEARTBEAT_MS);
  };

  const stopInterval = () => {
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  };

  const clearForegroundTimer = () => {
    if (foregroundTimer) {
      clearTimeout(foregroundTimer);
      foregroundTimer = null;
    }
  };

  const onVisibilityChange = () => {
    const visible = options?.isVisible ? options.isVisible() : true;
    if (visible) {
      if (backgroundTimer) {
        clearTimeout(backgroundTimer);
        backgroundTimer = null;
      }
      // Still heartbeating through a short background flicker — keep going.
      if (interval) return;
      // Confirm foreground — push/headless wakes and remounts must not mark online.
      clearForegroundTimer();
      foregroundTimer = setTimeout(() => {
        foregroundTimer = null;
        if (stopped) return;
        if (options?.isVisible && !options.isVisible()) return;
        startInterval();
      }, PRESENCE_FOREGROUND_CONFIRM_MS);
    } else {
      clearForegroundTimer();
      if (backgroundTimer) clearTimeout(backgroundTimer);
      backgroundTimer = setTimeout(() => {
        backgroundTimer = null;
        stopInterval();
      }, PRESENCE_BACKGROUND_STOP_DEBOUNCE_MS);
    }
  };

  if (!options?.isVisible) {
    // No visibility probe — assume always-foreground host.
    startInterval();
  } else if (options.isVisible()) {
    // Cold start / remount: same confirm path as resume (no instant tick).
    onVisibilityChange();
  }

  return {
    stop() {
      stopped = true;
      stopInterval();
      clearForegroundTimer();
      if (backgroundTimer) clearTimeout(backgroundTimer);
    },
    onVisibilityChange,
  };
}

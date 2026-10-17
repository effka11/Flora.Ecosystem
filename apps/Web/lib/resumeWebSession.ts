import type { SessionSnapshot } from "@flora/client-core/auth";
import {
  authPublicFetchUrl,
  hasPendingProfileSetup,
  saveSession,
  syncStoredSessionTokens,
} from "@/lib/auth";
import { webApiFetch } from "@/lib/apiClient";
import { webSessionStore } from "@/lib/sessionStore";

export type ResumeWebSessionResult = "feed" | "profile" | "login" | "hold";

export type ResumeWebSessionDeps = {
  readSession: () => Promise<SessionSnapshot>;
  syncStoredSessionTokens: () => Promise<void>;
  probeRefresh: () => Promise<Response>;
  saveSession: (raw: unknown) => void;
  hasPendingProfileSetup: () => boolean;
};

const defaultDeps: ResumeWebSessionDeps = {
  readSession: () => webSessionStore.readSession(),
  syncStoredSessionTokens: () => syncStoredSessionTokens(),
  probeRefresh: probeRefreshCookie,
  saveSession,
  hasPendingProfileSetup,
};

let visitGeneration = 0;
let visitResume: Promise<ResumeWebSessionResult> | null = null;

/** Test-only. A real logout notifies the store and drops the visit on its own. */
export function resetResumeWebSessionVisitForTests(): void {
  visitGeneration = 0;
  visitResume = null;
}

webSessionStore.subscribeSessionCleared(() => {
  visitGeneration += 1;
  visitResume = null;
});

/**
 * One refresh per visit: stored refresh → sync, otherwise a single cookie probe.
 * `hold` already includes the one sync retry. The caller must not sync or probe again.
 */
export function resumeWebSession(deps?: ResumeWebSessionDeps): Promise<ResumeWebSessionResult> {
  if (deps) return runResume(deps);
  return resumeCachedVisit();
}

function resumeCachedVisit(): Promise<ResumeWebSessionResult> {
  if (visitResume) return visitResume;
  const generation = visitGeneration;
  const run = runResume(defaultDeps).then(
    (result) => (visitGeneration === generation ? result : "login"),
    () => "login" as const,
  );
  // A clear during the synchronous read must not pin the invalidated visit.
  if (visitGeneration === generation) visitResume = run;
  return run;
}

async function probeRefreshCookie(): Promise<Response> {
  return webApiFetch(authPublicFetchUrl("/api/auth/refresh"), {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
}

async function runResume(deps: ResumeWebSessionDeps): Promise<ResumeWebSessionResult> {
  const before = await readSessionOrNull(deps);
  if (!before) return "login";
  if (before.session?.refresh) return resumeStored(deps);
  return resumeFromCookie(deps);
}

async function resumeStored(deps: ResumeWebSessionDeps): Promise<ResumeWebSessionResult> {
  await syncQuiet(deps);
  const after = await readSessionOrNull(deps);
  if (!hasRefresh(after)) return "login";
  if (hasAccess(after)) return destination(deps);
  await syncQuiet(deps);
  const retried = await readSessionOrNull(deps);
  if (!hasRefresh(retried)) return "login";
  if (!hasAccess(retried)) return "hold";
  return destination(deps);
}

async function resumeFromCookie(deps: ResumeWebSessionDeps): Promise<ResumeWebSessionResult> {
  let response: Response;
  try {
    response = await deps.probeRefresh();
  } catch {
    return "login";
  }
  if (!response.ok) return "login";
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return "login";
  }
  try {
    deps.saveSession(raw);
  } catch {
    return "login";
  }
  const saved = await readSessionOrNull(deps);
  if (!hasRefresh(saved) || !hasAccess(saved)) return "login";
  return destination(deps);
}

async function syncQuiet(deps: ResumeWebSessionDeps): Promise<void> {
  try {
    await deps.syncStoredSessionTokens();
  } catch {
    // A transport failure leaves the stored record. Confirmed invalid clears it inside sync.
  }
}

async function readSessionOrNull(deps: ResumeWebSessionDeps): Promise<SessionSnapshot | null> {
  try {
    return await deps.readSession();
  } catch {
    return null;
  }
}

function hasRefresh(snapshot: SessionSnapshot | null): boolean {
  return Boolean(snapshot?.session?.refresh);
}

function hasAccess(snapshot: SessionSnapshot | null): boolean {
  const access = snapshot?.session?.accessToken;
  return typeof access === "string" && access.trim().length > 0;
}

function destination(deps: ResumeWebSessionDeps): "feed" | "profile" {
  return deps.hasPendingProfileSetup() ? "profile" : "feed";
}

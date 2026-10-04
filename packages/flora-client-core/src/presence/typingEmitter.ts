/** Idle after last character before posting isTyping:false. */
export const PRESENCE_TYPING_IDLE_MS = 3000;
/** Client throttle for repeated isTyping:true while still typing. */
export const PRESENCE_TYPING_REFRESH_MS = 1000;
/** Peer UI safety hide if false signal is lost (idle + refresh/coalesce). */
export const PRESENCE_TYPING_PEER_TTL_MS = 4000;

export type TypingEmitterDeps = {
  postTyping: (isTyping: boolean) => void | Promise<void>;
  onTrueHeartbeat?: () => void | Promise<void>;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (id: unknown) => void;
};

export type TypingEmitter = {
  onText: (text: string) => void;
  stop: () => void;
  dispose: () => void;
};

/**
 * Instant typing start/stop with idle→false and throttled true refresh.
 * First true in a session is never throttled; idle timer resets on every non-empty onText.
 */
export function createTypingEmitter(deps: TypingEmitterDeps): TypingEmitter {
  const now = deps.now ?? (() => Date.now());
  const setTimeoutFn = deps.setTimeoutFn ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimeoutFn =
    deps.clearTimeoutFn ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));

  let active = false;
  let lastTrueAt = 0;
  let idleTimer: unknown = null;
  let disposed = false;

  const clearIdle = () => {
    if (idleTimer != null) {
      clearTimeoutFn(idleTimer);
      idleTimer = null;
    }
  };

  const postTrue = () => {
    lastTrueAt = now();
    void Promise.resolve(deps.postTyping(true)).catch(() => {});
    if (deps.onTrueHeartbeat) {
      void Promise.resolve(deps.onTrueHeartbeat()).catch(() => {});
    }
  };

  const postFalse = () => {
    void Promise.resolve(deps.postTyping(false)).catch(() => {});
  };

  const armIdle = () => {
    clearIdle();
    idleTimer = setTimeoutFn(() => {
      idleTimer = null;
      if (!active || disposed) return;
      active = false;
      postFalse();
    }, PRESENCE_TYPING_IDLE_MS);
  };

  const stop = () => {
    clearIdle();
    if (!active) return;
    active = false;
    if (!disposed) postFalse();
  };

  const onText = (text: string) => {
    if (disposed) return;
    if (!text.trim()) {
      stop();
      return;
    }
    armIdle();
    const t = now();
    if (!active || t - lastTrueAt >= PRESENCE_TYPING_REFRESH_MS) {
      active = true;
      postTrue();
      return;
    }
    active = true;
  };

  const dispose = () => {
    if (disposed) return;
    stop();
    disposed = true;
  };

  return { onText, stop, dispose };
}

type PromptListener = (visible: boolean) => void;

type PendingPrompt = {
  promise: Promise<boolean>;
  resolve: (allowed: boolean) => void;
};

let listener: PromptListener | null = null;
let pending: PendingPrompt | null = null;

export function subscribeInstallPermissionPrompt(listenerCb: PromptListener): () => void {
  listener = listenerCb;
  return () => {
    if (listener === listenerCb) listener = null;
  };
}

/**
 * Show the in-app install-permission modal. Resolves when the user chooses
 * «Нет, спасибо» / dismisses (false), or finishes «Разрешить» (grant result).
 */
export function openInstallPermissionPrompt(): Promise<boolean> {
  if (pending) return pending.promise;

  let resolvePrompt!: (allowed: boolean) => void;
  const promise = new Promise<boolean>((resolve) => {
    resolvePrompt = resolve;
  });
  pending = { promise, resolve: resolvePrompt };
  if (!listener) {
    // Host not mounted (Play build / early boot) — do not hang the Update button.
    queueMicrotask(() => resolveInstallPermissionPrompt(false));
    return promise;
  }
  listener(true);
  return promise;
}

export function resolveInstallPermissionPrompt(allowed: boolean): void {
  const current = pending;
  pending = null;
  listener?.(false);
  current?.resolve(allowed);
}

export function isInstallPermissionPromptOpen(): boolean {
  return pending != null;
}

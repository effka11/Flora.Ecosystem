import { isMessagesListScrolling } from "@/lib/messagesListScrollActivity";

/** Hover waits this long before decrypt / media. The ciphertext GET is not delayed. */
export const HOVER_INTENT_MS = 100;

type HoverJob = {
  timer: ReturnType<typeof setTimeout>;
  aborted: boolean;
};

const jobs = new Map<string, HoverJob>();

export function isThreadWarmBlocked(): boolean {
  if (isMessagesListScrolling()) return true;
  if (typeof document !== "undefined" && document.hidden) return true;
  return false;
}

export function scheduleHoverThreadWarm(key: string, run: (isAborted: () => boolean) => void): void {
  cancelHoverThreadWarm(key);
  if (isThreadWarmBlocked()) return;
  const job: HoverJob = { timer: 0 as unknown as ReturnType<typeof setTimeout>, aborted: false };
  job.timer = setTimeout(() => {
    jobs.delete(key);
    if (job.aborted || isThreadWarmBlocked()) return;
    run(() => job.aborted || isThreadWarmBlocked());
  }, HOVER_INTENT_MS);
  jobs.set(key, job);
}

export function cancelHoverThreadWarm(key: string): void {
  const job = jobs.get(key);
  if (!job) return;
  job.aborted = true;
  clearTimeout(job.timer);
  jobs.delete(key);
}

export function cancelAllHoverThreadWarms(): void {
  for (const key of [...jobs.keys()]) cancelHoverThreadWarm(key);
}

export function hoverThreadWarmCountForTests(): number {
  return jobs.size;
}

import { decryptFscpWireEnvelope, type FscpMessagePlaintext } from "@/lib/fscp";

const BATCH_SIZE = 3;

export type MessagesListPreviewJob = {
  peerUuid: string;
  enc: string;
  msgKey: string;
};

type BatchOptions = {
  jobs: MessagesListPreviewJob[];
  viewerNorm: string;
  agreementPrivateKey: Uint8Array;
  getLatestMsgKey: (peerUuid: string) => string | null;
  onSuccess: (peerUuid: string, msgKey: string, plain: FscpMessagePlaintext) => void;
  onFail: (peerUuid: string, msgKey: string) => void;
};

export function scheduleMessagesListPreviewBatch(options: BatchOptions): () => void {
  let cancelled = false;
  let queue = [...options.jobs];
  let idleId: number | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const processBatch = async () => {
    if (cancelled) return;
    const batch = queue.splice(0, BATCH_SIZE);
    if (batch.length === 0) return;

    await Promise.all(
      batch.map(async (job) => {
        if (cancelled) return;
        try {
          const plain = await decryptFscpWireEnvelope({
            wire: job.enc,
            viewerUserUuid: options.viewerNorm,
            agreementPrivateKey: options.agreementPrivateKey,
          });
          if (cancelled) return;
          if (options.getLatestMsgKey(job.peerUuid) !== job.msgKey) return;
          options.onSuccess(job.peerUuid, job.msgKey, plain);
        } catch {
          if (cancelled) return;
          if (options.getLatestMsgKey(job.peerUuid) !== job.msgKey) return;
          options.onFail(job.peerUuid, job.msgKey);
        }
      }),
    );

    if (!cancelled && queue.length > 0) scheduleNext();
  };

  const scheduleNext = () => {
    if (cancelled) return;
    if (typeof window !== "undefined" && "requestIdleCallback" in window) {
      idleId = window.requestIdleCallback(() => void processBatch(), { timeout: 2_000 });
      return;
    }
    timeoutId = setTimeout(() => void processBatch(), 0);
  };

  scheduleNext();

  return () => {
    cancelled = true;
    if (idleId !== null && typeof window !== "undefined" && "cancelIdleCallback" in window) {
      window.cancelIdleCallback(idleId);
    }
    if (timeoutId !== null) clearTimeout(timeoutId);
    queue = [];
  };
}

import type { MsgGroupDetail, MsgGroupMessagesPage } from "@flora/client-core/contracts";

/**
 * Group open sequencing: messages paint before detail merge and mark-read.
 * Mark-read runs from `afterPaint`, never before the message page is applied.
 */
export async function loadGroupThreadAfterOpen<TDetail>(args: {
  fetchMessages: () => Promise<MsgGroupMessagesPage>;
  fetchDetail: () => Promise<TDetail>;
  markRead: () => Promise<void>;
  onMessages: (page: MsgGroupMessagesPage) => void;
  onDetail: (detail: TDetail) => void;
  afterPaint: (run: () => void) => void;
  isCancelled: () => boolean;
}): Promise<void> {
  const detailTask = args
    .fetchDetail()
    .then((detail) => {
      if (!args.isCancelled()) args.onDetail(detail);
    })
    .catch(() => undefined);

  const page = await args.fetchMessages();
  if (args.isCancelled()) {
    await detailTask;
    return;
  }
  args.onMessages(page);
  args.afterPaint(() => {
    if (args.isCancelled()) return;
    void args.markRead();
  });
  await detailTask;
}

export type { MsgGroupDetail };

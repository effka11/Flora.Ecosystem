import {
  messageBlocksToPreview,
  type FscpImageBlock,
  type FscpMessageReplyRef,
  type FscpVoiceBlock,
} from "@flora/client-core/fscp";

export type MessageReplyDraft = FscpMessageReplyRef;

export type MessageReplyPreviewSource = {
  previewText: string;
  text: string;
  imageBlocks: readonly FscpImageBlock[];
  voiceBlock?: FscpVoiceBlock;
};

export type MessageReplySource = MessageReplyPreviewSource & {
  messageUuid: string;
  isFromMe: boolean;
  decryptState?: string;
  sendStatus?: string;
};

export function replyPreviewFromMessage(message: MessageReplyPreviewSource): string {
  const trimmed = message.previewText.trim() || message.text.trim();
  if (trimmed) return trimmed;
  return messageBlocksToPreview([
    ...(message.voiceBlock ? [message.voiceBlock] : []),
    ...message.imageBlocks,
  ]);
}

export function canReplyToMessage(message: MessageReplySource | null | undefined): boolean {
  if (!message) return false;
  if (message.decryptState !== "ok") return false;
  if (message.sendStatus === "sending") return false;
  return replyPreviewFromMessage(message).length > 0;
}

export function replyDraftFromMessage(
  message: Pick<MessageReplySource, "messageUuid" | "isFromMe"> & MessageReplyPreviewSource,
  peerDisplayName: string,
): MessageReplyDraft | null {
  const preview = replyPreviewFromMessage(message);
  if (!preview) return null;
  return {
    messageUuid: message.messageUuid,
    authorDisplayName: message.isFromMe ? "Вы" : peerDisplayName,
    preview,
  };
}

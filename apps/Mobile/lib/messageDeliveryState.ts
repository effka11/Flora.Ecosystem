export type MessageDeliveryState = "sending" | "sent" | "read";

type DeliverySource = {
  isFromMe: boolean;
  isRead?: boolean;
  sendStatus?: "sending";
};

export function messageDeliveryState(source: DeliverySource): MessageDeliveryState | null {
  if (!source.isFromMe) return null;
  if (source.sendStatus === "sending") return "sending";
  return source.isRead ? "read" : "sent";
}

/**
 * Статус последнего сообщения для превью списка чатов — по тому же серверному
 * `is_read` (`lastMessageIsRead`), что рисует галочки в пузыре.
 */
export function conversationLastMessageState(params: {
  isFromMe: boolean;
  isRead: boolean;
  isSending: boolean;
}): MessageDeliveryState | null {
  if (!params.isFromMe) return null;
  if (params.isSending) return "sending";
  return params.isRead ? "read" : "sent";
}

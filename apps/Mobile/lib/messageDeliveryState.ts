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

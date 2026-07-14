/** AAD для RKE — байт-в-байт как в docs/fscp/FSCP.md (UUID в нижнем регистре). */
export function recipientKeyEnvelopeAadLine(params: {
  conversationUuid: string;
  keyEpochId: string;
  messageUuid: string;
  messageKeyId: string;
  senderUserUuid: string;
  senderDeviceUuid: string;
  recipientUserUuid: string;
  recipientDeviceUuid: string;
  recipientAgreementPublicKeyId: string;
}): string {
  const p = params;
  return [
    "flora.messaging.recipient-key-envelope.v1",
    p.conversationUuid.toLowerCase(),
    p.keyEpochId.toLowerCase(),
    p.messageUuid.toLowerCase(),
    p.messageKeyId.toLowerCase(),
    p.senderUserUuid.toLowerCase(),
    p.senderDeviceUuid.toLowerCase(),
    p.recipientUserUuid.toLowerCase(),
    p.recipientDeviceUuid.toLowerCase(),
    p.recipientAgreementPublicKeyId.toLowerCase(),
  ].join(" | ");
}

export function messageBodyAadLine(params: {
  conversationUuid: string;
  keyEpochId: string;
  messageUuid: string;
  messageKeyId: string;
  senderUserUuid: string;
  senderDeviceUuid: string;
  createdAt: string;
}): string {
  const p = params;
  return [
    "flora.messaging.message.v1",
    p.conversationUuid.toLowerCase(),
    p.keyEpochId.toLowerCase(),
    p.messageUuid.toLowerCase(),
    p.messageKeyId.toLowerCase(),
    p.senderUserUuid.toLowerCase(),
    p.senderDeviceUuid.toLowerCase(),
    p.createdAt,
  ].join(" | ");
}

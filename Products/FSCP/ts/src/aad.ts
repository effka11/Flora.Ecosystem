/** AAD для RKE — байт-в-байт как в Documents/fscp/FSCP.md (UUID в нижнем регистре). */
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

const MESSAGE_BODY_CONTEXT_V1 = "flora.messaging.message.v1";
const MESSAGE_BODY_CONTEXT_V1_1 = "flora.messaging.message.v1_1";

export function messageBodyAadLine(params: {
  conversationUuid: string;
  keyEpochId: string;
  messageUuid: string;
  messageKeyId: string;
  senderUserUuid: string;
  senderDeviceUuid: string;
  createdAt: string;
  /**
   * FSCP-FRANK (franking.md §4.2): тег переключает строку на версию `v1_1` и уходит
   * в суффикс — подмена тега сервером ломает AEAD у получателя. Без тега строка
   * побайтово равна v1 (замороженный wire).
   */
  frankTagBase64Url?: string | null;
}): string {
  const p = params;
  const frankTag = p.frankTagBase64Url?.trim();
  const fields = [
    frankTag ? MESSAGE_BODY_CONTEXT_V1_1 : MESSAGE_BODY_CONTEXT_V1,
    p.conversationUuid.toLowerCase(),
    p.keyEpochId.toLowerCase(),
    p.messageUuid.toLowerCase(),
    p.messageKeyId.toLowerCase(),
    p.senderUserUuid.toLowerCase(),
    p.senderDeviceUuid.toLowerCase(),
    p.createdAt,
  ];
  if (frankTag) fields.push(frankTag);
  return fields.join(" | ");
}

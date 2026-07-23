import { requireOptionalNativeModule } from "expo-modules-core";

export type SecurePushCapability = {
  installationUuid: string;
  securePreviewVersion: 1;
  previewKeyId: string;
  previewPublicKeyBase64Url: string;
};

type FloraSecurePushNative = {
  ensureCapability(ownerUserUuid: string): SecurePushCapability;
  setPreviewsEnabled(enabled: boolean): void;
  arePreviewsEnabled(): boolean;
  setActiveConversation(conversationUuid: string | null): void;
  setAppForeground(foreground: boolean): void;
  cancelConversationNotification(conversationUuid: string): void;
  clear(): void;
};

const native = requireOptionalNativeModule<FloraSecurePushNative>("FloraSecurePush");

export function ensureSecurePushCapability(
  ownerUserUuid: string,
): SecurePushCapability | null {
  if (!native) return null;
  return native.ensureCapability(ownerUserUuid);
}

export function setSecurePushPreviewsEnabled(enabled: boolean): void {
  native?.setPreviewsEnabled(enabled);
}

export function areSecurePushPreviewsEnabled(): boolean {
  return native?.arePreviewsEnabled() ?? true;
}

export function setSecurePushActiveConversation(conversationUuid: string | null): void {
  native?.setActiveConversation(conversationUuid);
}

export function setSecurePushAppForeground(foreground: boolean): void {
  native?.setAppForeground(foreground);
}

export function cancelSecurePushConversationNotification(conversationUuid: string): void {
  native?.cancelConversationNotification(conversationUuid);
}

export function clearSecurePushMaterial(): void {
  native?.clear();
}

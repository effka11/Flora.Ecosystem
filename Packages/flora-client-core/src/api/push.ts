import { authFetch } from "./client.js";

export type SecurePushPreviewCapability = {
  installationUuid: string;
  securePreviewVersion: 1;
  previewKeyId: string;
  previewPublicKeyBase64Url: string;
};

export async function apiRegisterPushToken(
  token: string,
  platform: "android" | "ios" = "android",
  capability?: SecurePushPreviewCapability,
): Promise<void> {
  const r = await authFetch("/api/auth/push-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token,
      platform,
      provider: platform === "ios" ? "apns" : "fcm",
      ...capability,
    }),
  });
  if (!r.ok) {
    const { ApiRequestError } = await import("./errors.js");
    throw new ApiRequestError(r.status, await r.text());
  }
}

export async function apiUnregisterPushToken(token: string): Promise<void> {
  const r = await authFetch("/api/auth/push-token", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!r.ok) {
    const { ApiRequestError } = await import("./errors.js");
    throw new ApiRequestError(r.status, await r.text());
  }
}

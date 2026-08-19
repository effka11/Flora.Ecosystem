export { ApiRequestError, isApiRequestError, isNetworkError, isUpgradeRequired, parseApiError, parseApiErrorBody, parseApiErrorMessage, throwApiRequestError } from "./errors.js";
export type { ParsedApiError } from "./errors.js";
export {
  configureApiClient,
  primeApiBaseUrl,
  getApiClientConfig,
  apiUrl,
  authFetch,
  authGetJson,
  authGetArrayBuffer,
  authPostJson,
  authPutJson,
  authPatchJson,
  authPostForm,
  authDelete,
  authDeleteJson,
  publicPostJson,
  publicGetJson,
  ensureFreshAccessToken,
  notifyIfSessionRevoked,
  notifyUnauthorized,
  rejectUploadUnauthorized,
  refreshSession,
  refreshSessionIfPossible,
  supersedeSessionRefresh,
  syncStoredSessionTokens,
  type ApiClientConfig,
} from "./client.js";
export type {
  RunRefreshExclusive,
  SessionRefreshOutcome,
} from "./sessionCoordinator.js";
export * from "./social.js";
export * from "./social-ext.js";
export * from "./messaging.js";
export * from "./groups.js";
export * from "./chatOrganizer.js";
export * from "./voiceAssets.js";
export * from "./notifications.js";
export * from "./push.js";
export * from "./music.js";
export * from "./franking.js";
export * from "./frankingSubmit.js";

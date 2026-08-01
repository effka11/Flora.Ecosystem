export {
  PresenceStore,
  sharedPresenceStore,
  apiPresenceHeartbeat,
  apiPresenceWatch,
  apiGetPresence,
  apiPostTyping,
  startPresenceHeartbeat,
  PRESENCE_MAX_WATCH,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_BACKGROUND_STOP_DEBOUNCE_MS,
  PRESENCE_WATCH_REFRESH_MS,
} from "./store.js";
export type { PresenceSnapshot } from "./store.js";
export {
  createTypingEmitter,
  PRESENCE_TYPING_IDLE_MS,
  PRESENCE_TYPING_REFRESH_MS,
  PRESENCE_TYPING_PEER_TTL_MS,
} from "./typingEmitter.js";
export type { TypingEmitter, TypingEmitterDeps } from "./typingEmitter.js";

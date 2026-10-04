/**
 * Audio PoC gate (Phase 0):
 * - Foreground playback via expo-audio
 * - Range streaming with Authorization header against /api/music/tracks/{id}/stream
 * - Decision: expo-audio for MVP; track-player if background lock-screen controls fail QA
 */
export const AUDIO_POC_NOTES = {
  primary: "expo-audio",
  fallback: "react-native-track-player",
  requiresAuthorizationHeader: true,
} as const;

export { FSCP_BOOTSTRAP_DEVICE_UUID, FSCP_BOOTSTRAP_KEY_EPOCH_ID, FSCP_WIRE_PREFIX } from "./constants";
export {
  buildFscpWireEnvelope,
  decryptFscpWireEnvelope,
  isFscpWirePayload,
  type FscpMessageBlock,
  type FscpMessagePlaintext,
  type FscpMessageReplyRef,
  type FscpTextBlock,
  type FscpVoiceBlock,
  type FscpImageBlock,
  type FscpVideoBlock,
} from "./envelope";
export {
  clearFscpLegacyFlatKeys,
  clearFscpLocalStorage,
  clearFscpMaterialForUser,
  type FscpLocalMaterial,
} from "./keys";
export { getSodium } from "./sodium";
export {
  buildUnlockCompleteCanonical,
  buildDeviceKeyCanonical,
  ed25519Sign,
  ed25519PublicKeyFromPrivate,
  generateEd25519KeyPair,
  generateX25519KeyPair,
  signUnlockCompletePayload,
  signDeviceKeyBinding,
  type EpochMaterial,
  type EpochSignatureEntry,
  type UnlockCompleteSigningInput,
  type UnlockCompleteSignedPayload,
  type DeviceKeySigningInput,
} from "./unlockFlow";
export {
  generateRecoveryPhrase,
  normalizeRecoveryPhrase,
  validateRecoveryPhrase,
  RECOVERY_WORDLIST_ID,
  RECOVERY_WORDS_COUNT,
} from "./recoveryPhrase";
export {
  createKeyBackup,
  decryptKeyBackup,
  createRecoveryBackup,
  decryptRecoveryBackup,
  bootstrapPlaintextFromLocalMaterial,
  type KeyBackupPlaintext,
  type KeyBackupPayloadOut,
  type RecoveryBackupPayloadOut,
} from "./keyBackup";

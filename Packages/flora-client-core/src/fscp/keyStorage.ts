export type FscpProfileRecord = {
  agreementPrivateB64: string;
  signingPrivateB64: string;
  deviceUuidFromServer: string | null;
};

export type FscpKeyStorageAdapter = {
  getProfile(ownerNorm: string): Promise<FscpProfileRecord | null>;
  setProfile(ownerNorm: string, record: FscpProfileRecord): Promise<void>;
  clearProfile(ownerNorm: string): Promise<void>;
  clearAllProfiles(): Promise<void>;
};

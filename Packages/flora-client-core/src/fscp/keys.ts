import { getSodium, scalarmultBase } from "./sodium.js";
import type { FscpKeyStorageAdapter, FscpProfileRecord } from "./keyStorage.js";

const VARIANT = 7;

export type FscpLocalMaterial = {
  agreementPrivateKey: Uint8Array;
  signingPrivateKey: Uint8Array;
  deviceUuidFromServer: string | null;
};

function agreementScalar32FromBoxSecret(sk: Uint8Array): Uint8Array {
  if (sk.byteLength === 32) return sk;
  if (sk.byteLength === 64) return sk.subarray(0, 32);
  throw new Error("FSCP: unexpected agreement private key length.");
}

function b64u(bytes: Uint8Array, sodium: Awaited<ReturnType<typeof getSodium>>): string {
  return sodium.to_base64(bytes, VARIANT);
}

function fromB64(s: string, sodium: Awaited<ReturnType<typeof getSodium>>): Uint8Array {
  return sodium.from_base64(s, VARIANT);
}

export async function clearFscpMaterialForUser(
  storage: FscpKeyStorageAdapter,
  ownerUserUuid: string,
): Promise<void> {
  const k = ownerUserUuid.trim().toLowerCase();
  if (!k) return;
  await storage.clearProfile(k);
}

/** Sole entry point for generating a new FSCP identity (crypto_box_keypair). */
export async function createInitialFscpIdentity(): Promise<FscpLocalMaterial> {
  const sodium = await getSodium();
  const box = sodium.crypto_box_keypair();
  const sign = sodium.crypto_sign_keypair();
  return {
    agreementPrivateKey: agreementScalar32FromBoxSecret(box.privateKey),
    signingPrivateKey: sign.privateKey,
    deviceUuidFromServer: null,
  };
}

export async function loadFscpLocalMaterial(
  storage: FscpKeyStorageAdapter,
  ownerUserUuid: string,
): Promise<FscpLocalMaterial | null> {
  const sodium = await getSodium();
  const ownerNorm = ownerUserUuid.trim().toLowerCase();
  if (!ownerNorm) return null;

  const profile = await storage.getProfile(ownerNorm);
  if (!profile) return null;

  const dev = profile.deviceUuidFromServer;
  return {
    agreementPrivateKey: agreementScalar32FromBoxSecret(fromB64(profile.agreementPrivateB64, sodium)),
    signingPrivateKey: fromB64(profile.signingPrivateB64, sodium),
    deviceUuidFromServer: dev === "" ? null : dev,
  };
}

export async function persistFscpLocalMaterial(
  storage: FscpKeyStorageAdapter,
  ownerUserUuid: string,
  material: FscpLocalMaterial,
): Promise<void> {
  const sodium = await getSodium();
  const ownerNorm = ownerUserUuid.trim().toLowerCase();
  if (!ownerNorm) throw new Error("FSCP: empty owner userUuid.");

  await storage.setProfile(ownerNorm, {
    agreementPrivateB64: b64u(material.agreementPrivateKey, sodium),
    signingPrivateB64: b64u(material.signingPrivateKey, sodium),
    deviceUuidFromServer: material.deviceUuidFromServer,
  });
}

export async function deriveAgreementPublicKeyBytes(material: FscpLocalMaterial): Promise<Uint8Array> {
  const sodium = await getSodium();
  return scalarmultBase(sodium, material.agreementPrivateKey);
}

export async function agreementPublicKeyBase64Url(material: FscpLocalMaterial): Promise<string> {
  const sodium = await getSodium();
  const bytes = await deriveAgreementPublicKeyBytes(material);
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

/**
 * Self-consistency check of LOCAL material, required before it may OVERWRITE a server backup.
 * Verifies that:
 *  1) the agreement private key still derives the server-published agreement public key, and
 *  2) the signing keypair round-trips a detached sign/verify.
 * Returns false on any inconsistency or error so the caller refuses the overwrite.
 *
 * Rationale (review п.1): the agreement pubkey is DERIVED from the private scalar (not stored),
 * so a match already proves the decryption-critical key is intact; this additionally guards the
 * signing key and future-proofs against ever persisting corrupted local keys over the only backup.
 */
export async function localMaterialSelfCheck(
  material: FscpLocalMaterial,
  serverAgreementPub: Uint8Array,
): Promise<boolean> {
  try {
    const sodium = await getSodium();
    if (serverAgreementPub.length !== 32) return false;
    const localPub = scalarmultBase(sodium, material.agreementPrivateKey);
    if (localPub.length !== 32) return false;
    for (let i = 0; i < 32; i++) {
      if (localPub[i] !== serverAgreementPub[i]) return false;
    }
    const signPub =
      material.signingPrivateKey.byteLength >= 64
        ? material.signingPrivateKey.subarray(32, 64)
        : null;
    if (!signPub || signPub.length !== 32) return false;
    const probe = new TextEncoder().encode("flora.fscp.self-check.v1");
    const sig = sodium.crypto_sign_detached(probe, material.signingPrivateKey);
    return sodium.crypto_sign_verify_detached(sig, probe, signPub);
  } catch {
    return false;
  }
}

/**
 * @deprecated Use resolveFscpMaterialOnDevice for mobile; kept for Web CurrentUserContext.
 */
export async function loadOrCreateFscpLocalMaterial(
  storage: FscpKeyStorageAdapter,
  uploadAgreementPublic: (
    publicKeyBase64Url: string,
    deviceUuid: string | null,
  ) => Promise<{ deviceUuid: string }>,
  ownerUserUuid: string,
): Promise<FscpLocalMaterial> {
  const sodium = await getSodium();
  const ownerNorm = ownerUserUuid.trim().toLowerCase();
  if (!ownerNorm) throw new Error("FSCP: empty owner userUuid.");

  const profile = await storage.getProfile(ownerNorm);

  if (profile) {
    let dev = profile.deviceUuidFromServer;
    const agB64 = profile.agreementPrivateB64;
    const sgB64 = profile.signingPrivateB64;

    if (dev === null || dev === "") {
      const agSk = agreementScalar32FromBoxSecret(fromB64(agB64, sodium));
      const pubAg = b64u(scalarmultBase(sodium, agSk), sodium);
      try {
        const up = await uploadAgreementPublic(pubAg, null);
        dev = up.deviceUuid;
        await storage.setProfile(ownerNorm, {
          agreementPrivateB64: agB64,
          signingPrivateB64: sgB64,
          deviceUuidFromServer: dev,
        });
      } catch {
        /* server may not support device_uuid migration */
      }
    }

    return {
      agreementPrivateKey: agreementScalar32FromBoxSecret(fromB64(agB64, sodium)),
      signingPrivateKey: fromB64(sgB64, sodium),
      deviceUuidFromServer: dev,
    };
  }

  const material = await createInitialFscpIdentity();
  const agB64 = b64u(material.agreementPrivateKey, sodium);
  const sgB64 = b64u(material.signingPrivateKey, sodium);
  let dev: string | null = null;
  const pubAg = b64u(scalarmultBase(sodium, material.agreementPrivateKey), sodium);
  try {
    const up = await uploadAgreementPublic(pubAg, null);
    dev = up.deviceUuid;
  } catch {
    dev = null;
  }

  material.deviceUuidFromServer = dev;
  await storage.setProfile(ownerNorm, {
    agreementPrivateB64: agB64,
    signingPrivateB64: sgB64,
    deviceUuidFromServer: dev,
  });

  return material;
}

export type { FscpProfileRecord };

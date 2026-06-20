import { decryptAesGcmBlob, encryptAesGcmBlob, type AesGcmSubtle } from "@flora/client-core/crypto";
import QuickCrypto from "react-native-quick-crypto";

const subtle = QuickCrypto.webcrypto.subtle as AesGcmSubtle;

export async function encryptMessageMediaBlob(blob: Blob, contentType: string) {
  return encryptAesGcmBlob(subtle, blob, contentType);
}

export async function decryptMessageMediaBlob(params: {
  encryptedBlob: Blob;
  keyBase64Url: string;
  nonceBase64Url: string;
  contentType: string;
}) {
  return decryptAesGcmBlob(subtle, params);
}

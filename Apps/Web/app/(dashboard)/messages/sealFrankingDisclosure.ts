import { sealFrankingDisclosureV1, toBase64Url, utf8Bytes } from "@flora/client-core/fscp";
import { getSodium } from "@/lib/fscp";

/** Opaque disclosureCiphertext for POST /api/messaging/franking/reports. */
export async function sealMessageReportDisclosure(payload: unknown): Promise<string> {
  const sodium = await getSodium();
  const { sealed } = sealFrankingDisclosureV1(sodium, utf8Bytes(JSON.stringify(payload)));
  return toBase64Url(sealed);
}

import { v5 as uuidv5 } from "uuid";
import { FLORA_UUID_NAMESPACE } from "./constants.js";

export function dmConversationUuid(userA: string, userB: string): string {
  const a = userA.toLowerCase();
  const b = userB.toLowerCase();
  const [x, y] = a < b ? [a, b] : [b, a];
  return uuidv5(`${x}|${y}|fscp-dm-v1`, FLORA_UUID_NAMESPACE);
}

export function agreementPublicKeyId(userUuid: string, keyEpochId: string): string {
  return uuidv5(`${userUuid.toLowerCase()}|${keyEpochId.toLowerCase()}|agreement-v1`, FLORA_UUID_NAMESPACE);
}

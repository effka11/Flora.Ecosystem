import { v7 as uuidv7 } from "uuid";

/** Случайный UUID v7 (time-ordered). Для v5 — см. `fscp/deriveIds.ts`. */
export function floraNewUuid(): string {
  return uuidv7();
}

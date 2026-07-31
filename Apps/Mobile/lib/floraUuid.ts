import { v7 as uuidv7 } from "uuid";

/** Случайный UUID v7 (time-ordered). */
export function floraNewUuid(): string {
  return uuidv7();
}

import { FLORA_DEFAULT_AVATAR_COLOR, FLORA_DEFAULT_AVATAR_COLOR_ID } from "./defaultPalette.js";

export function resolveDefaultAvatarColorId(_seed?: string | null): string {
  return FLORA_DEFAULT_AVATAR_COLOR_ID;
}

export function resolveDefaultAvatarColor(_seed?: string | null): string {
  return FLORA_DEFAULT_AVATAR_COLOR;
}

export {
  coverColorIdToColor,
  FLORA_DEFAULT_COVER_ID,
  FLORA_DEFAULT_COVERS,
  type FloraDefaultCover,
} from "@flora/client-core/display";

/** @deprecated Use FLORA_DEFAULT_COVERS */
export { FLORA_DEFAULT_COVERS as MUSIC_DEFAULT_COVERS } from "@flora/client-core/display";

/** @deprecated Use FLORA_DEFAULT_COVER_ID */
export { FLORA_DEFAULT_COVER_ID as MUSIC_DEFAULT_COVER_ID } from "@flora/client-core/display";

export type MusicDefaultCover = import("@flora/client-core/display").FloraDefaultCover;

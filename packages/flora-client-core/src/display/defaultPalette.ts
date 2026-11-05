export type FloraDefaultCover = {
  id: string;
  color: string;
};

/** Базовая палитра Flora (music covers + default avatars). Сетка 4×2 по hue. */
export const FLORA_DEFAULT_COVERS: FloraDefaultCover[] = [
  { id: "wine", color: "#5a3540" },
  { id: "ember", color: "#5c423c" },
  { id: "clay", color: "#7a5c45" },
  { id: "ochre", color: "#655c38" },
  { id: "forest", color: "#303132" },
  { id: "slate", color: "#3d4a5c" },
  { id: "dusk", color: "#4a3d5a" },
  { id: "ink", color: "#1a1a22" },
];

/** Графитовый фон базового аватара (совпадает с --flora-accent-dark). */
export const FLORA_DEFAULT_AVATAR_COLOR_ID = "forest";
export const FLORA_DEFAULT_AVATAR_COLOR = "#303132";

export const FLORA_DEFAULT_COVER_ID = "forest";

export function coverColorIdToColor(coverColorId: string | null | undefined): string {
  const cover = FLORA_DEFAULT_COVERS.find((item) => item.id === coverColorId);
  return cover?.color ?? FLORA_DEFAULT_COVERS.find((item) => item.id === FLORA_DEFAULT_COVER_ID)!.color;
}

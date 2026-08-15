export type MusicBrowseTab = "recommendations" | "myMusic";
export type MusicUploadTab = "forSelf" | "forPlatform";

type TabItem<T extends string> = {
  id: T;
  label: string;
};

export const MUSIC_UPLOAD_TABS: readonly TabItem<MusicUploadTab>[] = [
  { id: "forSelf", label: "Для себя" },
  { id: "forPlatform", label: "На площадку" },
];

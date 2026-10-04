"use client";

import { UploadForPlatformForm } from "@/app/(dashboard)/music/UploadForPlatformForm";
import { UploadForSelfForm } from "@/app/(dashboard)/music/UploadForSelfForm";
import styles from "./music.module.css";

export type AddTrackUploadMode = "forSelf" | "forPlatform";

type AddTrackTabProps = {
  uploadMode: AddTrackUploadMode;
  onUploaded?: () => void;
};

export function AddTrackTab({ uploadMode, onUploaded }: AddTrackTabProps) {
  return (
    <div
      className={styles.addTrackWrap}
      aria-label={uploadMode === "forSelf" ? "Загрузить для себя" : "Загрузить на площадку"}
    >
      {uploadMode === "forSelf" ? (
        <UploadForSelfForm onUploaded={onUploaded} />
      ) : (
        <UploadForPlatformForm onUploaded={onUploaded} />
      )}
    </div>
  );
}

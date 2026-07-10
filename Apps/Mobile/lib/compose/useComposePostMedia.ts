import * as ImagePicker from "expo-image-picker";
import { getInfoAsync } from "expo-file-system";
import { useCallback, useState } from "react";
import { Image } from "react-native-compressor";
import {
  MAX_POST_IMAGE_BYTES,
  MAX_POST_IMAGES,
  MAX_POST_VIDEO_BYTES,
} from "@/lib/compose/composeModes";
import type { ComposeUploadFile } from "@/lib/compose/postMediaUpload";

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
]);

export type DraftPostImage = {
  id: string;
  uri: string;
  contentType: string;
  fileName: string;
  preparing: boolean;
};

export type DraftPostVideo = {
  id: string;
  uri: string;
  contentType: string;
  fileName: string;
};

function newDraftId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeImageMime(mimeType?: string | null, fileName?: string | null): string | null {
  const raw = (mimeType ?? "").toLowerCase().split(";")[0].trim();
  if (ALLOWED_IMAGE_TYPES.has(raw)) return raw;
  const ext = (fileName ?? "").split(".").pop()?.toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return null;
}

function normalizeVideoMime(mimeType?: string | null, fileName?: string | null): string | null {
  const raw = (mimeType ?? "").toLowerCase().split(";")[0].trim();
  if (ALLOWED_VIDEO_TYPES.has(raw)) return raw;
  const name = (fileName ?? "").toLowerCase();
  if (name.endsWith(".mp4") || name.endsWith(".m4v")) return "video/mp4";
  if (name.endsWith(".mov")) return "video/quicktime";
  if (name.endsWith(".webm")) return "video/webm";
  if (name.endsWith(".mkv")) return "video/x-matroska";
  return null;
}

function fileNameForImageType(type: string): string {
  if (type === "image/png") return "photo.png";
  if (type === "image/webp") return "photo.webp";
  return "photo.jpg";
}

async function fileSize(uri: string): Promise<number | null> {
  try {
    const info = await getInfoAsync(uri);
    if (!info.exists || typeof info.size !== "number") return null;
    return info.size;
  } catch {
    return null;
  }
}

async function preparePostImage(asset: ImagePicker.ImagePickerAsset): Promise<ComposeUploadFile> {
  const initialType = normalizeImageMime(asset.mimeType, asset.fileName);
  if (!initialType) throw new Error("Поддерживаются JPEG, PNG и WebP до 5 МБ.");

  let uri = asset.uri;
  let type = initialType;
  const initialSize = await fileSize(asset.uri);
  if (initialSize == null || initialSize > MAX_POST_IMAGE_BYTES * 0.9) {
    try {
      uri = await Image.compress(asset.uri, {
        maxWidth: 2048,
        maxHeight: 2048,
        quality: 0.88,
        output: "jpg",
      });
      type = "image/jpeg";
    } catch {
      uri = asset.uri;
      type = initialType;
    }
  }

  const size = await fileSize(uri);
  if (size != null && size > MAX_POST_IMAGE_BYTES) {
    throw new Error("Фото слишком большое даже после сжатия.");
  }

  return { uri, mimeType: type, fileName: fileNameForImageType(type) };
}

export function useComposePostMedia() {
  const [images, setImages] = useState<DraftPostImage[]>([]);
  const [video, setVideo] = useState<DraftPostVideo | null>(null);

  const clearMedia = useCallback(() => {
    setImages([]);
    setVideo(null);
  }, []);

  const removeImageAt = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const clearVideo = useCallback(() => {
    setVideo(null);
  }, []);

  const pickImages = useCallback(async (): Promise<string | null> => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return "Нужен доступ к галерее.";

    const remaining = MAX_POST_IMAGES - images.length;
    if (remaining <= 0) return `Можно прикрепить не более ${MAX_POST_IMAGES} фото.`;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: remaining,
      quality: 1,
    });
    if (result.canceled || result.assets.length === 0) return null;

    const nextDrafts: DraftPostImage[] = [];
    let skippedInvalid = 0;

    for (const asset of result.assets) {
      if (images.length + nextDrafts.length >= MAX_POST_IMAGES) break;
      const id = newDraftId();
      nextDrafts.push({
        id,
        uri: asset.uri,
        contentType: "image/jpeg",
        fileName: "photo.jpg",
        preparing: true,
      });
      void preparePostImage(asset)
        .then((prepared) => {
          setImages((current) =>
            current.map((image) =>
              image.id === id
                ? {
                    ...image,
                    uri: prepared.uri,
                    contentType: prepared.mimeType,
                    fileName: prepared.fileName,
                    preparing: false,
                  }
                : image,
            ),
          );
        })
        .catch(() => {
          skippedInvalid += 1;
          setImages((current) => current.filter((image) => image.id !== id));
        });
    }

    if (nextDrafts.length > 0) {
      setVideo(null);
      setImages((prev) => [...prev, ...nextDrafts]);
    }

    if (nextDrafts.length === 0 && skippedInvalid > 0) {
      return "Поддерживаются JPEG, PNG и WebP до 5 МБ.";
    }
    return null;
  }, [images.length]);

  const pickVideo = useCallback(async (): Promise<string | null> => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return "Нужен доступ к галерее.";

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["videos"],
      allowsMultipleSelection: false,
      quality: 1,
    });
    if (result.canceled || !result.assets[0]) return null;

    const asset = result.assets[0];
    const mime = normalizeVideoMime(asset.mimeType, asset.fileName);
    if (!mime) return "Поддерживаются MP4, MOV, WebM и MKV.";

    const size = asset.fileSize ?? (await fileSize(asset.uri));
    if (size != null && size > MAX_POST_VIDEO_BYTES) return "Видео до 200 МБ.";

    const name = asset.fileName?.trim() || "video.mp4";
    setVideo({
      id: newDraftId(),
      uri: asset.uri,
      contentType: mime,
      fileName: name,
    });
    setImages([]);
    return null;
  }, []);

  const hasPendingPrepare = images.some((image) => image.preparing);
  const readyImageFiles: ComposeUploadFile[] = images
    .filter((image) => !image.preparing)
    .map((image) => ({
      uri: image.uri,
      fileName: image.fileName,
      mimeType: image.contentType,
    }));

  const videoFile: ComposeUploadFile | null = video
    ? { uri: video.uri, fileName: video.fileName, mimeType: video.contentType }
    : null;

  return {
    images,
    video,
    hasPendingPrepare,
    readyImageFiles,
    videoFile,
    clearMedia,
    removeImageAt,
    clearVideo,
    pickImages,
    pickVideo,
  };
}

import * as ImagePicker from "expo-image-picker";
import { useCallback, useState } from "react";
import {
  MAX_MESSAGE_IMAGES,
  isSupportedMessageImageAsset,
  messageImageAttachError,
  prepareMessageImageFromAsset,
  type MergeMessageImagesResult,
} from "@/lib/messageImages";

export type DraftMessageImage = {
  id: string;
  uri: string;
  contentType: string;
  preparing: boolean;
};

function newDraftId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useMessageComposeImages() {
  const [images, setImages] = useState<DraftMessageImage[]>([]);
  /**
   * Сбой нативной подготовки (сжатие/перекодировка). Плитка при этом
   * убирается из полосы, но пользователь узнаёт причину, а не тихую пропажу.
   */
  const [prepareError, setPrepareError] = useState<string | null>(null);

  const clearPrepareError = useCallback(() => {
    setPrepareError(null);
  }, []);

  const clearImages = useCallback(() => {
    setImages([]);
  }, []);

  const removeImageAt = useCallback((index: number) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const pickImages = useCallback(async (): Promise<string | null> => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return "Нужен доступ к галерее.";

    const remaining = MAX_MESSAGE_IMAGES - images.length;
    if (remaining <= 0) return `Можно прикрепить не более ${MAX_MESSAGE_IMAGES} фото.`;

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      selectionLimit: remaining,
      quality: 1,
    });
    if (result.canceled || result.assets.length === 0) return null;

    let added = 0;
    let skippedInvalid = 0;
    let skippedLimit = 0;
    const nextDrafts: DraftMessageImage[] = [];
    const prepareJobs: { id: string; asset: ImagePicker.ImagePickerAsset }[] = [];

    for (const asset of result.assets) {
      if (images.length + nextDrafts.length >= MAX_MESSAGE_IMAGES) {
        skippedLimit += 1;
        continue;
      }
      // Не-изображения отсеиваем до плейсхолдера: иначе плитка появится и
      // молча исчезнет после ошибки нативной подготовки. Неизвестный MIME
      // (контент-провайдер, HEIC) пропускаем — подготовка перекодирует в JPEG.
      if (!isSupportedMessageImageAsset(asset)) {
        skippedInvalid += 1;
        continue;
      }
      const id = newDraftId();
      const placeholder: DraftMessageImage = {
        id,
        uri: asset.uri,
        contentType: "image/jpeg",
        preparing: true,
      };
      nextDrafts.push(placeholder);
      prepareJobs.push({ id, asset });
      added += 1;
    }

    if (nextDrafts.length > 0) {
      setImages((prev) => [...prev, ...nextDrafts]);
    }

    // Сжатие — по одному: нативная перекодировка крупных фото не должна
    // конкурировать сама с собой (пик памяти и рывки JS-потока на релизе).
    // Первый кадр с плейсхолдерами успевает отрисоваться до блока.
    void (async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      for (const job of prepareJobs) {
        try {
          const prepared = await prepareMessageImageFromAsset(job.asset);
          setImages((current) =>
            current.map((image) =>
              image.id === job.id
                ? { ...image, uri: prepared.uri, contentType: prepared.contentType, preparing: false }
                : image,
            ),
          );
        } catch {
          setImages((current) => current.filter((image) => image.id !== job.id));
          setPrepareError("Не удалось подготовить фото. Попробуйте другое изображение.");
        }
      }
    })();

    const mergeResult: MergeMessageImagesResult = { added, skippedInvalid, skippedLimit };
    return messageImageAttachError(mergeResult);
  }, [images.length]);

  const hasPendingPrepare = images.some((image) => image.preparing);

  return {
    images,
    hasPendingPrepare,
    prepareError,
    clearPrepareError,
    clearImages,
    removeImageAt,
    pickImages,
  };
}

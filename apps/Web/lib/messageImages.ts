/** Лимиты фото в сообщениях — синхронно с ImportedSocialController.MaxMessageImageBytes. */
export const MAX_MESSAGE_IMAGES = 10;
export const MAX_MESSAGE_IMAGE_BYTES = 5 * 1024 * 1024;
export const MESSAGE_IMAGE_ACCEPT = "image/jpeg,image/png,image/webp";

const ALLOWED_MESSAGE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type MergeMessageImagesResult = {
  next: File[];
  added: number;
  skippedInvalid: number;
  skippedLimit: number;
};

function inferMessageImageMime(file: File): string | null {
  const type = file.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (ALLOWED_MESSAGE_IMAGE_TYPES.has(type)) return type;
  const name = file.name.trim().toLowerCase();
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".webp")) return "image/webp";
  return null;
}

export function normalizeMessageImageFile(file: File): File | null {
  const mime = inferMessageImageMime(file);
  if (!mime || file.size <= 0 || file.size > MAX_MESSAGE_IMAGE_BYTES) return null;
  if (file.type === mime) return file;
  const name =
    file.name.trim().length > 0
      ? file.name
      : `photo.${mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png"}`;
  return new File([file], name, { type: mime, lastModified: file.lastModified });
}

export function isAllowedMessageImageFile(file: File): boolean {
  return normalizeMessageImageFile(file) !== null;
}

export function mergeMessageImageFiles(existing: File[], incoming: FileList | File[]): MergeMessageImagesResult {
  const next = [...existing];
  let added = 0;
  let skippedInvalid = 0;
  let skippedLimit = 0;

  for (const raw of Array.from(incoming)) {
    if (next.length >= MAX_MESSAGE_IMAGES) {
      skippedLimit += 1;
      continue;
    }
    const file = normalizeMessageImageFile(raw);
    if (!file) {
      skippedInvalid += 1;
      continue;
    }
    next.push(file);
    added += 1;
  }

  return { next, added, skippedInvalid, skippedLimit };
}

/** JPEG/PNG/WebP из буфера обмена (Ctrl+V). */
export function extractPastedMessageImages(clipboardData: DataTransfer): File[] {
  const out: File[] = [];

  for (const item of Array.from(clipboardData.items)) {
    if (!item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    const normalized = file ? normalizeMessageImageFile(file) : null;
    if (!normalized) continue;
    out.push(normalized);
    if (out.length >= MAX_MESSAGE_IMAGES) break;
  }

  if (out.length > 0) return out;

  for (const file of Array.from(clipboardData.files)) {
    const normalized = normalizeMessageImageFile(file);
    if (!normalized) continue;
    out.push(normalized);
    if (out.length >= MAX_MESSAGE_IMAGES) break;
  }

  return out;
}

export function messageImageAttachError(result: Pick<MergeMessageImagesResult, "added" | "skippedInvalid" | "skippedLimit">): string | null {
  if (result.added > 0) return null;
  if (result.skippedLimit > 0) return `Не более ${MAX_MESSAGE_IMAGES} фото в одном сообщении.`;
  if (result.skippedInvalid > 0) return "Поддерживаются JPEG, PNG и WebP до 5 МБ.";
  return null;
}

const IMAGE_PREPARE_MAX_LONG_SIDE = 2048;
const JPEG_PREPARE_QUALITY = 0.88;
const PREVIEW_MAX_LONG_SIDE = 320;
const IMAGE_DECODE_TIMEOUT_MS = 15_000;

export type PreparedMessageImage = {
  blob: Blob;
  contentType: string;
  fileName: string;
  /** Маленький превью для полосы вложений: оригинал в 48 МП не декодируем. */
  previewBlob: Blob;
};

type LoadedMessageImage = {
  image: HTMLImageElement;
  width: number;
  height: number;
};

function loadMessageImage(url: string): Promise<LoadedMessageImage> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = window.setTimeout(() => {
      img.src = "";
      reject(new Error("Не удалось прочитать фото."));
    }, IMAGE_DECODE_TIMEOUT_MS);
    img.onload = () => {
      window.clearTimeout(timer);
      resolve({ image: img, width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error("Не удалось прочитать фото."));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Не удалось сжать фото."))),
      mime,
      quality,
    );
  });
}

/**
 * Превью строится из уже декодированного img: полоса вложений больше не
 * декодирует оригинал каждым <img>, а держит только маленький blob.
 */
async function renderPreviewBlob(
  image: HTMLImageElement,
  width: number,
  height: number,
  sourceType: string,
): Promise<Blob> {
  const scale = Math.min(1, PREVIEW_MAX_LONG_SIDE / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D недоступен.");
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const mime = sourceType === "image/jpeg" ? "image/jpeg" : sourceType;
    return await canvasToBlob(canvas, mime, mime === "image/jpeg" ? 0.8 : undefined);
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

/**
 * Готовит фото к E2E-отправке: при необходимости уменьшает длинную сторону и перекодирует,
 * чтобы уложиться в лимит 5 МБ. Оригинал декодируется один раз — второй <img>
 * для drawImage больше не создаётся (пик памяти на крупных снимках).
 */
export async function prepareMessageImage(file: File): Promise<PreparedMessageImage> {
  const normalized = normalizeMessageImageFile(file);
  if (!normalized) throw new Error("Поддерживаются JPEG, PNG и WebP до 5 МБ.");

  const url = URL.createObjectURL(normalized);
  let decoded: HTMLImageElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  try {
    const loaded = await loadMessageImage(url);
    decoded = loaded.image;
    const { width, height } = loaded;
    const previewBlob = await renderPreviewBlob(decoded, width, height, normalized.type);
    const longSide = Math.max(width, height);
    const needsResize = longSide > IMAGE_PREPARE_MAX_LONG_SIDE;
    const needsShrink = normalized.size > MAX_MESSAGE_IMAGE_BYTES * 0.9;

    if (!needsResize && !needsShrink) {
      return {
        blob: normalized,
        contentType: normalized.type,
        fileName: normalized.name,
        previewBlob,
      };
    }

    const factor = needsResize ? IMAGE_PREPARE_MAX_LONG_SIDE / longSide : 1;
    const targetW = Math.max(1, Math.round(width * factor));
    const targetH = Math.max(1, Math.round(height * factor));

    canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D недоступен.");
    ctx.drawImage(decoded, 0, 0, targetW, targetH);

    const preferJpeg = needsShrink || normalized.type === "image/jpeg";
    const targetMime = preferJpeg ? "image/jpeg" : normalized.type;
    let blob = await canvasToBlob(
      canvas,
      targetMime,
      targetMime === "image/jpeg" ? JPEG_PREPARE_QUALITY : undefined,
    );

    if (blob.size > MAX_MESSAGE_IMAGE_BYTES && targetMime !== "image/jpeg") {
      blob = await canvasToBlob(canvas, "image/jpeg", JPEG_PREPARE_QUALITY);
    }
    if (blob.size > MAX_MESSAGE_IMAGE_BYTES) {
      blob = await canvasToBlob(canvas, "image/jpeg", 0.75);
    }
    if (blob.size > MAX_MESSAGE_IMAGE_BYTES) {
      throw new Error("Фото слишком большое даже после сжатия.");
    }

    const ext =
      blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
    const baseName = normalized.name.replace(/\.[^.]+$/, "") || "photo";
    return {
      blob,
      contentType: blob.type || targetMime,
      fileName: `${baseName}.${ext}`,
      previewBlob,
    };
  } finally {
    if (decoded) decoded.src = "";
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
    URL.revokeObjectURL(url);
  }
}

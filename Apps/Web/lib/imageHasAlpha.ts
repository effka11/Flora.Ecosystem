/** JPEG не поддерживает прозрачность — проверку альфы можно пропустить. */
export function imageMimeMayHaveAlpha(contentType?: string): boolean {
  const mime = contentType?.split(";")[0]?.trim().toLowerCase() ?? "";
  return mime === "image/png" || mime === "image/webp";
}

/**
 * Проверяет, есть ли в изображении хотя бы один полупрозрачный/прозрачный пиксель.
 * Для больших картинок семплирует сетку, чтобы не блокировать UI.
 */
export function detectImageHasAlpha(src: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const width = img.naturalWidth;
        const height = img.naturalHeight;
        if (width <= 0 || height <= 0) {
          resolve(false);
          return;
        }

        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) {
          resolve(false);
          return;
        }

        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, width, height);
        const stepX = Math.max(1, Math.floor(width / 48));
        const stepY = Math.max(1, Math.floor(height / 48));

        for (let y = 0; y < height; y += stepY) {
          for (let x = 0; x < width; x += stepX) {
            const alpha = data[(y * width + x) * 4 + 3] ?? 255;
            if (alpha < 255) {
              resolve(true);
              return;
            }
          }
        }

        resolve(false);
      } catch {
        resolve(false);
      }
    };
    img.onerror = () => resolve(false);
    img.src = src;
  });
}

"use client";

import {
  useEffect,
  useRef,
  type CanvasHTMLAttributes,
  type ImgHTMLAttributes,
  type SyntheticEvent,
} from "react";
import { useFrcImageSource, type FrcResolvedSource } from "@/lib/frcImageSource";

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string;
};

function paintBitmap(canvas: HTMLCanvasElement, bitmap: ImageBitmap): void {
  if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
  if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0);
}

export function FrcImage({ src, onLoad, onError, alt, loading, ...props }: Props) {
  const resolved = useFrcImageSource(src);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const source = resolved.source;

  useEffect(() => {
    if (!source || source.kind !== "bitmap") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    paintBitmap(canvas, source.bitmap);
    if (onLoad) {
      const event = {
        currentTarget: canvas,
        target: canvas,
      } as unknown as SyntheticEvent<HTMLImageElement>;
      onLoad(event);
    }
  }, [source, onLoad]);

  useEffect(() => {
    if (resolved.error && onError) {
      const event = {
        currentTarget: canvasRef.current,
        target: canvasRef.current,
      } as unknown as SyntheticEvent<HTMLImageElement>;
      onError(event);
    }
  }, [resolved.error, onError]);

  if (source?.kind === "url" && source.url) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        {...props}
        src={source.url}
        alt={alt ?? ""}
        loading={loading}
        data-frc-loading={resolved.loading || undefined}
        data-frc-error={resolved.error || undefined}
        onLoad={onLoad}
        onError={onError}
      />
    );
  }

  const canvasProps = props as CanvasHTMLAttributes<HTMLCanvasElement>;
  return (
    <canvas
      {...canvasProps}
      ref={canvasRef}
      role="img"
      aria-label={alt || undefined}
      data-frc-loading={resolved.loading || undefined}
      data-frc-error={resolved.error || undefined}
    />
  );
}

export type { FrcResolvedSource };

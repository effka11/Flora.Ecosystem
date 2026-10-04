"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  type CanvasHTMLAttributes,
  type ImgHTMLAttributes,
  type SyntheticEvent,
} from "react";
import {
  destBackingSize,
  objectFitDrawRect,
  parseObjectFit,
  parseObjectPosition,
  writeFrcNaturalSize,
  type DrawRect,
} from "@/lib/frcCanvasPaint";
import { useFrcImageSource, type FrcResolvedSource } from "@/lib/frcImageSource";

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src: string;
};

function subscribeDevicePixelRatio(onChange: () => void): () => void {
  let media: MediaQueryList | null = null;
  const handle = () => {
    onChange();
    listen();
  };
  const listen = () => {
    media?.removeEventListener("change", handle);
    media = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    media.addEventListener("change", handle);
  };
  listen();
  return () => media?.removeEventListener("change", handle);
}

function stepwiseDrawImage(
  context: CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  rect: DrawRect,
): void {
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  let source: CanvasImageSource = bitmap;
  let sx = rect.sx;
  let sy = rect.sy;
  let sw = rect.sw;
  let sh = rect.sh;
  while (sw > rect.dw * 2 && sh > rect.dh * 2) {
    const nextW = Math.max(rect.dw, Math.ceil(sw / 2));
    const nextH = Math.max(rect.dh, Math.ceil(sh / 2));
    const tmp = document.createElement("canvas");
    tmp.width = nextW;
    tmp.height = nextH;
    const tmpContext = tmp.getContext("2d");
    if (!tmpContext) break;
    tmpContext.imageSmoothingEnabled = true;
    tmpContext.imageSmoothingQuality = "high";
    tmpContext.drawImage(source, sx, sy, sw, sh, 0, 0, nextW, nextH);
    source = tmp;
    sx = 0;
    sy = 0;
    sw = nextW;
    sh = nextH;
  }
  context.drawImage(source, sx, sy, sw, sh, rect.dx, rect.dy, rect.dw, rect.dh);
}

async function paintFrcCanvas(
  canvas: HTMLCanvasElement,
  bitmap: ImageBitmap,
  generation: number,
  currentGeneration: () => number,
): Promise<boolean> {
  writeFrcNaturalSize(canvas, bitmap.width, bitmap.height);
  const dest = destBackingSize(
    canvas.clientWidth,
    canvas.clientHeight,
    window.devicePixelRatio || 1,
    bitmap.width,
    bitmap.height,
  );
  if (canvas.width !== dest.width) canvas.width = dest.width;
  if (canvas.height !== dest.height) canvas.height = dest.height;
  if (currentGeneration() !== generation) return false;

  const style = window.getComputedStyle(canvas);
  const rect = objectFitDrawRect(
    bitmap.width,
    bitmap.height,
    dest.width,
    dest.height,
    parseObjectFit(style.objectFit),
    parseObjectPosition(style.objectPosition),
  );

  let resized: ImageBitmap | null = null;
  try {
    resized = await createImageBitmap(bitmap, rect.sx, rect.sy, rect.sw, rect.sh, {
      resizeWidth: rect.dw,
      resizeHeight: rect.dh,
      resizeQuality: "high",
    });
  } catch {
    resized = null;
  }
  if (currentGeneration() !== generation) {
    resized?.close();
    return false;
  }

  if (canvas.width !== dest.width) canvas.width = dest.width;
  if (canvas.height !== dest.height) canvas.height = dest.height;
  const context = canvas.getContext("2d");
  if (!context) {
    resized?.close();
    return false;
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (resized) {
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(resized, rect.dx, rect.dy);
    resized.close();
    return true;
  }
  stepwiseDrawImage(context, bitmap, rect);
  return currentGeneration() === generation;
}

export function FrcImage({ src, onLoad, onError, alt, loading, ...props }: Props) {
  const resolved = useFrcImageSource(src);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const source = resolved.source;

  useLayoutEffect(() => {
    if (!source || source.kind !== "bitmap") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bitmap = source.bitmap;

    let paintGen = 0;
    let cancelled = false;
    let loadNotified = false;

    const currentGeneration = () => (cancelled ? -1 : paintGen);
    const notifyLoad = () => {
      if (loadNotified || cancelled || !onLoad) return;
      loadNotified = true;
      const event = {
        currentTarget: canvas,
        target: canvas,
      } as unknown as SyntheticEvent<HTMLImageElement>;
      onLoad(event);
    };

    const run = () => {
      if (cancelled) return;
      const generation = ++paintGen;
      void paintFrcCanvas(canvas, bitmap, generation, currentGeneration).then((ok) => {
        if (ok) notifyLoad();
      });
    };

    writeFrcNaturalSize(canvas, bitmap.width, bitmap.height);
    if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
    if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
    run();
    const observer = new ResizeObserver(run);
    observer.observe(canvas);
    const unsubscribeDpr = subscribeDevicePixelRatio(run);
    return () => {
      cancelled = true;
      paintGen += 1;
      observer.disconnect();
      unsubscribeDpr();
    };
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
    return (
      // eslint-disable-next-line @next/next/no-img-element
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

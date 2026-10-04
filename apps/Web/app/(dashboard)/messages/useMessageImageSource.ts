"use client";

import { useEffect, useMemo, useState } from "react";
import type { FscpImageBlock } from "@/lib/fscp";
import { ensureMessageImageObjectUrl, peekMessageMediaObjectUrl } from "@/lib/messageMediaCache";

export function useMessageImageSource(
  imageBlock: FscpImageBlock | undefined,
  localBlob?: Blob,
  localUrl?: string,
) {
  const blobPreviewUrl = useMemo(() => {
    if (!localBlob) return "";
    return URL.createObjectURL(localBlob);
  }, [localBlob]);

  useEffect(
    () => () => {
      if (blobPreviewUrl) URL.revokeObjectURL(blobPreviewUrl);
    },
    [blobPreviewUrl],
  );

  const [fetchedUrl, setFetchedUrl] = useState(() =>
    imageBlock ? peekMessageMediaObjectUrl(imageBlock.assetUuid) ?? "" : "",
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sourceUrl = localUrl || blobPreviewUrl || fetchedUrl;

  useEffect(() => {
    if (!imageBlock) {
      setFetchedUrl("");
      return;
    }
    const cached = peekMessageMediaObjectUrl(imageBlock.assetUuid);
    if (cached) {
      setFetchedUrl(cached);
      setLoading(false);
      setError(null);
    }
  }, [imageBlock]);

  useEffect(() => {
    if (sourceUrl || !imageBlock) return;
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const url = await ensureMessageImageObjectUrl(imageBlock);
        if (!cancelled) setFetchedUrl(url);
      } catch {
        if (!cancelled) setError("Не удалось загрузить фото");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [imageBlock, sourceUrl]);

  return { sourceUrl, loading, error };
}

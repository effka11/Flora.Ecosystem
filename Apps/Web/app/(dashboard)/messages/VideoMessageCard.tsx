"use client";

import { useEffect, useState } from "react";
import { FloraVideoPlayer } from "@/app/_shared/FloraVideoPlayer";
import type { FscpVideoBlock } from "@/lib/fscp";
import { ensureMessageVideoObjectUrl, peekMessageMediaObjectUrl } from "@/lib/messageMediaCache";
import styles from "./messages.module.css";

/** Видео в пузыре: скачать шифроблоб → расшифровать (AES-GCM) → object URL → плеер. */
export function VideoMessageCard({
  videoBlock,
  localBlob,
}: {
  videoBlock?: FscpVideoBlock;
  localBlob?: Blob;
}) {
  const [sourceUrl, setSourceUrl] = useState(() =>
    videoBlock ? peekMessageMediaObjectUrl(videoBlock.assetUuid) ?? "" : "",
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!localBlob) return;
    const url = URL.createObjectURL(localBlob);
    setSourceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [localBlob]);

  useEffect(() => {
    if (!videoBlock || localBlob) return;
    const cached = peekMessageMediaObjectUrl(videoBlock.assetUuid);
    if (cached) {
      setSourceUrl(cached);
      setLoading(false);
      setError(null);
    }
  }, [videoBlock, localBlob]);

  useEffect(() => {
    if (sourceUrl || localBlob || !videoBlock) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const url = await ensureMessageVideoObjectUrl(videoBlock);
        if (!cancelled) setSourceUrl(url);
      } catch {
        if (!cancelled) setError("Не удалось загрузить видео");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [videoBlock, localBlob, sourceUrl]);

  return (
    <div className={styles.messageVideoCard}>
      {loading ? <span className={styles.messageImagePlaceholder}>Загрузка видео…</span> : null}
      {error ? <span className={styles.messageImagePlaceholder}>{error}</span> : null}
      {sourceUrl ? (
        <FloraVideoPlayer
          src={sourceUrl}
          compact
          width={videoBlock?.width}
          height={videoBlock?.height}
          downloadContentType={localBlob?.type || videoBlock?.contentType}
        />
      ) : null}
    </div>
  );
}

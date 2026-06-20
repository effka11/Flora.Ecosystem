"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import lightboxStyles from "@/app/_shared/FeedPostImages.module.css";
import { detectImageHasAlpha, imageMimeMayHaveAlpha } from "@/lib/imageHasAlpha";
import type { FscpImageBlock } from "@/lib/fscp";
import styles from "./messages.module.css";
import { useMessageImageSource } from "./useMessageImageSource";

export function ImageMessageCard({
  imageBlock,
  localBlob,
  localUrl,
  onRemove,
}: {
  imageBlock?: FscpImageBlock;
  localBlob?: Blob;
  localUrl?: string;
  onRemove?: () => void;
}) {
  const { sourceUrl, loading, error } = useMessageImageSource(imageBlock, localBlob, localUrl);
  const [open, setOpen] = useState(false);
  const [hasAlpha, setHasAlpha] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (!sourceUrl) {
        if (!cancelled) setHasAlpha(false);
        return;
      }

      const contentType = imageBlock?.contentType ?? localBlob?.type;
      if (contentType && !imageMimeMayHaveAlpha(contentType)) {
        if (!cancelled) setHasAlpha(false);
        return;
      }

      const transparent = await detectImageHasAlpha(sourceUrl);
      if (!cancelled) setHasAlpha(transparent);
    })();

    return () => {
      cancelled = true;
    };
  }, [sourceUrl, imageBlock?.contentType, localBlob?.type]);

  const closeModal = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeModal();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, closeModal]);

  const modal =
    open && sourceUrl && typeof document !== "undefined"
      ? createPortal(
          <div
            className={lightboxStyles.modalBackdrop}
            role="dialog"
            aria-modal="true"
            aria-label="Просмотр фото"
            onClick={closeModal}
          >
            <div className={lightboxStyles.modal} onClick={(event) => event.stopPropagation()}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className={lightboxStyles.modalImage} src={sourceUrl} alt="" onClick={closeModal} />
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <figure className={styles.messageImageCard} data-has-alpha={hasAlpha ? "true" : undefined}>
        {loading ? <span className={styles.messageImagePlaceholder}>Загрузка…</span> : null}
        {error ? <span className={styles.messageImagePlaceholder}>{error}</span> : null}
        {sourceUrl ? (
          <button
            type="button"
            className={styles.messageImageButton}
            onClick={() => setOpen(true)}
            aria-label="Открыть фото"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={styles.messageImage} src={sourceUrl} alt="" loading="lazy" />
          </button>
        ) : null}
        {onRemove ? (
          <button type="button" className={styles.messageImageRemove} onClick={onRemove} aria-label="Убрать фото">
            ×
          </button>
        ) : null}
      </figure>
      {modal}
    </>
  );
}

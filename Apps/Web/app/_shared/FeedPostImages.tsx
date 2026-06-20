"use client";



import { useCallback, useEffect, useMemo, useState } from "react";

import { createPortal } from "react-dom";

import { postImageUrl } from "@/lib/socialApi";

import styles from "./FeedPostImages.module.css";



export type FeedPostImagePreviewItem = {

  id: string;

  src: string;

};



type FeedPostImagesProps = {

  imageUuids?: string[];

  /** Локальные превью (compose) — та же сетка, что у опубликованного поста. */

  previewItems?: FeedPostImagePreviewItem[];

  onRemovePreview?: (id: string) => void;

  className?: string;

};

const FEED_POST_COLLAGE_MAX_ITEMS = 10;
type FeedPostImageShape = "narrow" | "portrait" | "square" | "wide";

function feedPostImageShape(image: HTMLImageElement): FeedPostImageShape {
  const ratio = image.naturalWidth > 0 && image.naturalHeight > 0
    ? image.naturalWidth / image.naturalHeight
    : 1;

  if (ratio < 0.72) return "narrow";
  if (ratio < 0.95) return "portrait";
  if (ratio > 1.35) return "wide";
  return "square";
}



/** Сетка фото поста + лайтбокс (логика/дизайн из референса 2142-1). */

export function FeedPostImages({

  imageUuids = [],

  previewItems,

  onRemovePreview,

  className,

}: FeedPostImagesProps) {

  const items = useMemo((): FeedPostImagePreviewItem[] => {

    if (previewItems && previewItems.length > 0) return previewItems;

    return imageUuids.map((uuid) => ({ id: uuid, src: postImageUrl(uuid) }));

  }, [imageUuids, previewItems]);

  const visibleItems = useMemo(() => items.slice(0, FEED_POST_COLLAGE_MAX_ITEMS), [items]);



  const isPreview = Boolean(previewItems && previewItems.length > 0);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [imageShapes, setImageShapes] = useState<Record<string, FeedPostImageShape>>({});

  const activeItem = activeId ? visibleItems.find((item) => item.id === activeId) : undefined;



  const handleImageLoad = useCallback((id: string, image: HTMLImageElement) => {
    const nextShape = feedPostImageShape(image);
    setImageShapes((prev) => (prev[id] === nextShape ? prev : { ...prev, [id]: nextShape }));
  }, []);

  const closeModal = useCallback(() => setActiveId(null), []);



  useEffect(() => {

    if (!activeItem) return;

    const onKey = (e: KeyboardEvent) => {

      if (e.key === "Escape") closeModal();

    };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);

  }, [activeItem, closeModal]);



  if (visibleItems.length === 0) return null;



  const wrapClass = className ? `${styles.images} ${className}` : styles.images;

  const modal =

    activeItem && typeof document !== "undefined"

      ? createPortal(

          <div

            className={styles.modalBackdrop}

            role="dialog"

            aria-modal="true"

            aria-label="Просмотр фото"

            onClick={closeModal}

          >

            <div className={styles.modal} onClick={(e) => e.stopPropagation()}>

              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className={styles.modalImage} src={activeItem.src} alt="" onClick={closeModal} />

            </div>

          </div>,

          document.body,

        )

      : null;



  return (

    <>

      <div className={wrapClass} data-count={visibleItems.length}>

        {visibleItems.map((item, index) => (

          <div key={item.id} className={styles.imageCell} data-shape={imageShapes[item.id]}>

            <button

              type="button"

              className={styles.imageButton}

              onClick={() => setActiveId(item.id)}

              aria-label={`Открыть фото ${index + 1} из ${visibleItems.length}`}

            >

              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img

                className={styles.image}

                src={item.src}

                alt=""

                loading={isPreview ? undefined : "lazy"}

                onLoad={(event) => handleImageLoad(item.id, event.currentTarget)}

              />

            </button>

            {isPreview && onRemovePreview ? (

              <button

                type="button"

                className={styles.removePreviewBtn}

                aria-label="Убрать фото"

                onClick={(e) => {

                  e.stopPropagation();

                  onRemovePreview(item.id);

                }}

              >

                ×

              </button>

            ) : null}

          </div>

        ))}

      </div>

      {modal}

    </>

  );

}



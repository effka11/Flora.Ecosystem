"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { FeedPostImages } from "@/app/_shared/FeedPostImages";
import type { FscpImageBlock } from "@/lib/fscp";
import styles from "./messages.module.css";
import { useMessageImageSource } from "./useMessageImageSource";

type SlotSnapshot = {
  src: string;
  loading: boolean;
  error: string | null;
};

function MessageCollageImageSource({
  assetUuid,
  imageBlock,
  localBlob,
  onSnapshot,
}: {
  assetUuid: string;
  imageBlock?: FscpImageBlock;
  localBlob?: Blob;
  onSnapshot: (assetUuid: string, snapshot: SlotSnapshot) => void;
}) {
  const { sourceUrl, loading, error } = useMessageImageSource(imageBlock, localBlob);

  useEffect(() => {
    onSnapshot(assetUuid, { src: sourceUrl, loading, error });
  }, [assetUuid, sourceUrl, loading, error, onSnapshot]);

  return null;
}

type MessageImageCollageProps = {
  blocks: FscpImageBlock[];
  getLocalBlob?: (assetUuid: string) => Blob | undefined;
  skipDecrypt?: boolean;
};

/**
 * Коллаж фото в пузыре сообщения (как в постах).
 * Поле ввода не затрагивает — только отображение отправленного сообщения.
 */
export function MessageImageCollage({ blocks, getLocalBlob, skipDecrypt }: MessageImageCollageProps) {
  const [slotSnapshots, setSlotSnapshots] = useState<Record<string, SlotSnapshot>>({});

  const handleSnapshot = useCallback((assetUuid: string, snapshot: SlotSnapshot) => {
    setSlotSnapshots((prev) => {
      const current = prev[assetUuid];
      if (
        current &&
        current.src === snapshot.src &&
        current.loading === snapshot.loading &&
        current.error === snapshot.error
      ) {
        return prev;
      }
      return { ...prev, [assetUuid]: snapshot };
    });
  }, []);

  const previewItems = useMemo(
    () =>
      blocks
        .map((block) => ({
          id: block.assetUuid,
          src: slotSnapshots[block.assetUuid]?.src ?? "",
        }))
        .filter((item) => item.src.length > 0),
    [blocks, slotSnapshots],
  );

  const orderedSnapshots = blocks.map((block) => slotSnapshots[block.assetUuid]);
  const anyLoading = orderedSnapshots.some((snapshot) => snapshot?.loading);
  const allFailed =
    orderedSnapshots.length > 0 &&
    orderedSnapshots.every((snapshot) => snapshot?.error && !snapshot?.src);

  return (
    <>
      {blocks.map((block) => (
        <MessageCollageImageSource
          key={block.assetUuid}
          assetUuid={block.assetUuid}
          imageBlock={skipDecrypt ? undefined : block}
          localBlob={getLocalBlob?.(block.assetUuid)}
          onSnapshot={handleSnapshot}
        />
      ))}
      {previewItems.length > 0 ? (
        <FeedPostImages previewItems={previewItems} className={styles.messagesImageCollage} />
      ) : anyLoading ? (
        <span className={styles.messageImagePlaceholder}>Загрузка…</span>
      ) : allFailed ? (
        <span className={styles.messageImagePlaceholder}>Не удалось загрузить фото</span>
      ) : null}
    </>
  );
}

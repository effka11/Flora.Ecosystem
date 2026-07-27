import {
  FeedPostImages,
  type FeedPostImagePreviewItem,
} from "@/components/feed/FeedPostImages";
import type { FscpImageBlock } from "@flora/client-core/fscp";
import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { getStoredImageRatio } from "@/lib/imageRatioStore";
import { ensureMessageImageUri, peekMessageImageUri } from "@/lib/messageImageAssets";
import {
  DEFAULT_MESSAGE_IMAGE_RATIO,
  messageCollageHeight,
  messageSingleImageSize,
} from "@/lib/messageMediaGeometry";
import { floraColors, floraMessages } from "@/lib/theme";

type SlotState = {
  uri: string;
  loading: boolean;
  error: string | null;
};

type Props = {
  blocks: FscpImageBlock[];
  photoOnly: boolean;
  hasCaption: boolean;
  isFromMe: boolean;
  containerWidth: number;
};

function MessageImageSource({
  block,
  onSnapshot,
}: {
  block: FscpImageBlock;
  onSnapshot: (assetUuid: string, snapshot: SlotState) => void;
}) {
  const [state, setState] = useState<SlotState>(() => {
    const cached = peekMessageImageUri(block.assetUuid);
    return cached
      ? { uri: cached, loading: false, error: null }
      : { uri: "", loading: true, error: null };
  });

  useEffect(() => {
    const cached = peekMessageImageUri(block.assetUuid);
    if (cached) {
      setState({ uri: cached, loading: false, error: null });
      return;
    }
    let cancelled = false;
    void ensureMessageImageUri(block)
      .then((uri) => {
        if (!cancelled) setState({ uri, loading: false, error: null });
      })
      .catch((error) => {
        if (__DEV__) {
          console.warn("[message-image] decode failed", block.assetUuid, error);
        }
        if (!cancelled) setState({ uri: "", loading: false, error: "Ошибка" });
      });
    return () => {
      cancelled = true;
    };
  }, [block]);

  useEffect(() => {
    onSnapshot(block.assetUuid, state);
  }, [block.assetUuid, onSnapshot, state]);

  return null;
}

export function ChatMessageImageCollage({
  blocks,
  photoOnly,
  hasCaption,
  isFromMe,
  containerWidth,
}: Props) {
  const [slotSnapshots, setSlotSnapshots] = useState<Record<string, SlotState>>({});

  const handleSnapshot = useCallback((assetUuid: string, snapshot: SlotState) => {
    setSlotSnapshots((prev) => {
      const current = prev[assetUuid];
      if (
        current &&
        current.uri === snapshot.uri &&
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
        .map(
          (block): FeedPostImagePreviewItem => ({
            id: block.assetUuid,
            uri: slotSnapshots[block.assetUuid]?.uri ?? "",
          }),
        )
        .filter((item) => item.uri.length > 0),
    [blocks, slotSnapshots],
  );

  const orderedSnapshots = blocks.map((block) => slotSnapshots[block.assetUuid]);
  const anyLoading = orderedSnapshots.some((snapshot) => snapshot?.loading);
  const allFailed =
    orderedSnapshots.length > 0 &&
    orderedSnapshots.every((snapshot) => snapshot?.error && !snapshot?.uri);

  const isCollage = blocks.length >= 2;

  // Reserve the exact height the real collage/single photo will end up at,
  // so the placeholder doesn't cause a layout jump once decoding finishes.
  const loadingPlaceholderHeight = isCollage
    ? messageCollageHeight(blocks.length, floraMessages.messageCollageRowHeight)
    : messageSingleImageSize(
        containerWidth,
        (blocks[0] ? getStoredImageRatio(blocks[0].assetUuid) : null) ?? DEFAULT_MESSAGE_IMAGE_RATIO,
        floraMessages.messageSingleImageMaxHeight,
        Math.round,
      ).height;

  const layout = useMemo(
    () => ({
      fixedWidth: containerWidth,
      rowHeight: floraMessages.messageCollageRowHeight,
      marginBottom: 0,
      collageBorderRadius: hasCaption && isCollage ? floraMessages.composeRadius : 0,
      cellBorderRadius: 0,
      singleImageBorderRadius: 0,
      singleMaxHeight: floraMessages.messageSingleImageMaxHeight,
      messageSingleFill: !isCollage,
      messageImageAlign: isFromMe ? ("end" as const) : ("start" as const),
      messageMode: true,
    }),
    [containerWidth, hasCaption, isCollage, isFromMe],
  );

  return (
    <>
      {blocks.map((block) => (
        <MessageImageSource key={block.assetUuid} block={block} onSnapshot={handleSnapshot} />
      ))}
      {previewItems.length > 0 ? (
        <FeedPostImages previewItems={previewItems} layout={layout} />
      ) : anyLoading ? (
        <View style={[styles.placeholder, { width: containerWidth, height: loadingPlaceholderHeight }]}>
          <Text style={styles.placeholderText}>Загрузка…</Text>
        </View>
      ) : allFailed ? (
        <View style={[styles.placeholder, styles.placeholderError, { width: containerWidth }]}>
          <Text style={styles.placeholderText}>Не удалось загрузить фото</Text>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    borderRadius: floraMessages.composeRadius,
    backgroundColor: "rgba(250, 250, 250, 0.06)",
    alignItems: "center",
    justifyContent: "center",
  },
  // The error state doesn't know (and no longer needs) the real collage
  // height — it keeps the old compact reservation instead of the up-to-470px
  // placeholder the loading state now reserves.
  placeholderError: {
    height: floraMessages.messageCollageRowHeight * 2,
  },
  placeholderText: {
    color: floraColors.gray,
    fontSize: 13,
  },
});

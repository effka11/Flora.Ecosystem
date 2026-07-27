import { postImageUrl } from "@flora/client-core/display";
import { useRecyclingState } from "@shopify/flash-list";
import { Image } from "expo-image";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  Modal,
  PixelRatio,
  Pressable,
  StyleSheet,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { collageCellWidth, threeImageLeftCellWidth } from "@/lib/feedImageGeometry";
import { isLocalDecodedUri, useFrcImageUri } from "@/lib/frcImage";
import { getStoredImageRatio, rememberImageRatio } from "@/lib/imageRatioStore";
import {
  COLLAGE_MAX_ITEMS,
  DEFAULT_MESSAGE_IMAGE_RATIO,
  messageSingleImageSize,
} from "@/lib/messageMediaGeometry";
import { floraFeedPost, floraSpacing } from "@/lib/theme";

const MAX_ITEMS = COLLAGE_MAX_ITEMS;
const GRID = floraSpacing.grid;
const GAP = floraSpacing.gridFine;
const DEFAULT_ROW_HEIGHT = 7 * GRID;
const CELL_RADIUS = 10;
const COLLAGE_RADIUS = 12;
const SINGLE_IMAGE_RADIUS = CELL_RADIUS;
const MODAL_IMAGE_RADIUS = GAP;

export type FeedPostImagePreviewItem = {
  id: string;
  uri: string;
};

type ImageShape = "narrow" | "portrait" | "square" | "wide";

function shapeFromRatio(ratio: number): ImageShape {
  if (ratio < 0.72) return "narrow";
  if (ratio < 0.95) return "portrait";
  if (ratio > 1.35) return "wide";
  return "square";
}

const SINGLE_MAX: Record<ImageShape | "default", { w: number; h: number }> = {
  narrow: { w: 16 * GRID, h: 22 * GRID },
  portrait: { w: 20 * GRID, h: 24 * GRID },
  square: { w: 26 * GRID, h: 26 * GRID },
  wide: { w: 36 * GRID, h: 20 * GRID },
  default: { w: 22 * GRID, h: 24 * GRID },
};

function roundLayoutPx(value: number): number {
  return PixelRatio.roundToNearestPixel(value);
}

function computeSingleImageSize(containerWidth: number, ratio: number, shape: ImageShape) {
  const max = SINGLE_MAX[shape] ?? SINGLE_MAX.default;
  let w = Math.min(containerWidth, max.w);
  let h = w / ratio;
  if (h > max.h) {
    h = max.h;
    w = h * ratio;
  }
  return { width: roundLayoutPx(w), height: roundLayoutPx(h) };
}

export type FeedPostImagesLayout = {
  fixedWidth?: number;
  rowHeight?: number;
  marginBottom?: number;
  collageBorderRadius?: number;
  cellBorderRadius?: number;
  singleImageBorderRadius?: number;
  singleMaxHeight?: number;
  /** Одно фото на всю ширину пузыря (чат), не как в ленте. */
  messageSingleFill?: boolean;
  /** Выравнивание одного фото в пузыре (чат). */
  messageImageAlign?: "start" | "end";
  /** Чат: ширина из родителя, не растягивать wrapOuter на 100%. */
  messageMode?: boolean;
};

type Props = {
  imageUuids?: string[];
  previewItems?: FeedPostImagePreviewItem[];
  layout?: FeedPostImagesLayout;
};

type ClippedImageProps = {
  uri: string;
  width: number;
  height: number;
  borderRadius: number;
  imageIndex: number;
  contentFit?: "cover" | "contain";
  onPress?: () => void;
  onLoadRatio?: (ratio: number) => void;
  style?: StyleProp<ViewStyle>;
  transitionMs?: number;
};

function ClippedImage({
  uri,
  width,
  height,
  borderRadius,
  imageIndex,
  contentFit = "cover",
  onPress,
  onLoadRatio,
  style,
  transitionMs = 0,
}: ClippedImageProps) {
  // `width` is already the actual render width of this cell (single photo or
  // one collage tile, never the whole collage) — decode at that size instead
  // of the full-resolution FRI.
  const resolvedUri = useFrcImageUri(uri, { imageIndex, displayWidth: width });
  const image = (
    <View style={[{ width, height }, style]}>
      {resolvedUri ? (
        <Image
          source={{ uri: resolvedUri }}
          style={{ width, height, borderRadius }}
          contentFit={contentFit}
          cachePolicy={isLocalDecodedUri(resolvedUri) ? "memory" : "memory-disk"}
          recyclingKey={resolvedUri}
          transition={transitionMs}
          onLoad={(event) => {
            const { width: w, height: h } = event.source;
            if (w > 0 && h > 0) onLoadRatio?.(w / h);
          }}
        />
      ) : null}
    </View>
  );

  if (!onPress) return image;

  return (
    <Pressable onPress={onPress} accessibilityRole="button">
      {image}
    </Pressable>
  );
}

type CollageCellProps = {
  uri: string;
  width: number;
  height: number;
  borderRadius: number;
  imageIndex: number;
  onPress: () => void;
};

function CollageCell({ uri, width, height, borderRadius, imageIndex, onPress }: CollageCellProps) {
  return (
    <ClippedImage
      uri={uri}
      width={width}
      height={height}
      borderRadius={borderRadius}
      imageIndex={imageIndex}
      contentFit="cover"
      onPress={onPress}
      style={styles.cell}
    />
  );
}

/**
 * Lightbox must decode FRI → PNG the same way as thumbnails (raw FRI is not
 * Image-readable). No `displayWidth`: the modal shows the image at up to full
 * screen size in either dimension (`contentFit="contain"`), which is exactly
 * what the top rung of the cache's bucket ladder is for. The thumbnail bucket
 * already acquired for this post fills the frame instantly (stretched by
 * expo-image) while the full-size variant decodes in the background — no
 * extra "show small, then large" logic needed here.
 */
function ModalFrcImage({ uri }: { uri: string }) {
  const resolvedUri = useFrcImageUri(uri, { force: true });
  if (!resolvedUri) return null;
  return (
    <View style={[styles.modalClip, { borderRadius: MODAL_IMAGE_RADIUS }]}>
      <Image
        source={{ uri: resolvedUri }}
        style={[styles.modalImage, { borderRadius: MODAL_IMAGE_RADIUS }]}
        contentFit="contain"
        cachePolicy={isLocalDecodedUri(resolvedUri) ? "memory" : "memory-disk"}
        recyclingKey={resolvedUri}
        transition={0}
      />
    </View>
  );
}

export function FeedPostImages({ imageUuids = [], previewItems, layout }: Props) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const [containerWidth, setContainerWidth] = useState(0);
  const [activeUri, setActiveUri] = useState<string | null>(null);
  const singleRatioLockedRef = useRef(false);

  const items = useMemo(() => {
    if (previewItems && previewItems.length > 0) {
      return previewItems.slice(0, MAX_ITEMS);
    }
    return imageUuids.slice(0, MAX_ITEMS).map((id) => ({ id, uri: postImageUrl(id) }));
  }, [imageUuids, previewItems]);

  const firstItemId = items[0]?.id ?? "";
  // Seed sizing from the cache so a recycled row shows the correct dimensions
  // on first paint instead of collapsing to "square" and re-measuring.
  const [singleRatio, setSingleRatio] = useRecyclingState<number | null>(
    () => (firstItemId ? getStoredImageRatio(firstItemId) : null),
    [firstItemId, items.length],
    () => {
      singleRatioLockedRef.current = false;
    },
  );
  const singleShape: ImageShape = singleRatio != null ? shapeFromRatio(singleRatio) : "square";

  const rowHeight = layout?.rowHeight ?? DEFAULT_ROW_HEIGHT;
  const marginBottom = layout?.marginBottom ?? floraFeedPost.textMarginBottom;
  const collageBorderRadius = layout?.collageBorderRadius ?? COLLAGE_RADIUS;
  const cellBorderRadius = layout?.cellBorderRadius ?? CELL_RADIUS;
  const singleImageBorderRadius = layout?.singleImageBorderRadius ?? SINGLE_IMAGE_RADIUS;
  const singleMaxHeight = layout?.singleMaxHeight;
  const messageSingleFill = layout?.messageSingleFill ?? false;
  const messageImageAlign = layout?.messageImageAlign ?? "start";
  const messageMode = layout?.messageMode ?? false;

  const lockSingleRatio = useCallback(
    (nextRatio: number) => {
      if (messageMode && singleRatioLockedRef.current) return;
      if (messageMode) singleRatioLockedRef.current = true;
      if (firstItemId) rememberImageRatio(firstItemId, nextRatio);
      setSingleRatio((prev) => {
        if (prev !== null && Math.abs(prev - nextRatio) < 0.001) return prev;
        return nextRatio;
      });
    },
    [firstItemId, messageMode, setSingleRatio],
  );

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const w = event.nativeEvent.layout.width;
    if (w > 0) setContainerWidth(w);
  }, []);

  const closeModal = useCallback(() => setActiveUri(null), []);

  if (items.length === 0) return null;

  const width =
    layout?.fixedWidth ??
    (containerWidth > 0
      ? containerWidth
      : screenWidth - floraSpacing.grid * 2 - floraFeedPost.avatarSize - floraFeedPost.columnGap);

  if (messageMode && layout?.fixedWidth && width <= 0) return null;

  const renderCollage = () => {
    const count = items.length;

    if (count === 1) {
      if (messageSingleFill && singleMaxHeight) {
        const ratio = singleRatio ?? DEFAULT_MESSAGE_IMAGE_RATIO;
        const { width: imageWidth, height: imageHeight } = messageSingleImageSize(
          width,
          ratio,
          singleMaxHeight,
          roundLayoutPx,
        );
        return (
          <ClippedImage
            uri={items[0]!.uri}
            width={imageWidth}
            height={imageHeight}
            borderRadius={singleImageBorderRadius}
            imageIndex={0}
            contentFit="cover"
            onPress={() => setActiveUri(items[0]!.uri)}
            onLoadRatio={lockSingleRatio}
          />
        );
      }

      const max = SINGLE_MAX[singleShape] ?? SINGLE_MAX.default;
      const ratio = singleRatio ?? max.w / max.h;
      const { width: imageWidth, height: imageHeight } = computeSingleImageSize(width, ratio, singleShape);

      return (
        <ClippedImage
          uri={items[0]!.uri}
          width={imageWidth}
          height={imageHeight}
          borderRadius={singleImageBorderRadius}
          imageIndex={0}
          contentFit="cover"
          onPress={() => setActiveUri(items[0]!.uri)}
          onLoadRatio={lockSingleRatio}
        />
      );
    }

    const collage = (() => {
      if (count === 2) {
        const cellWidth = collageCellWidth(width, 2);
        const cellHeight = rowHeight * 2;
        return (
          <View style={[styles.row, { gap: GAP, width }]}>
            {items.map((item, index) => (
              <CollageCell
                key={item.id}
                uri={item.uri}
                width={cellWidth}
                height={cellHeight}
                borderRadius={cellBorderRadius}
                imageIndex={index}
                onPress={() => setActiveUri(item.uri)}
              />
            ))}
          </View>
        );
      }

      if (count === 3) {
        const leftWidth = threeImageLeftCellWidth(width);
        const rightWidth = Math.floor((width - GAP) / 3);
        const totalHeight = rowHeight * 2;
        const rightCellHeight = Math.floor((totalHeight - GAP) / 2);
        return (
          <View style={[styles.row, { gap: GAP, height: totalHeight, width }]}>
            <CollageCell
              uri={items[0]!.uri}
              width={leftWidth}
              height={totalHeight}
              borderRadius={cellBorderRadius}
              imageIndex={0}
              onPress={() => setActiveUri(items[0]!.uri)}
            />
            <View style={{ gap: GAP }}>
              <CollageCell
                uri={items[1]!.uri}
                width={rightWidth}
                height={rightCellHeight}
                borderRadius={cellBorderRadius}
                imageIndex={1}
                onPress={() => setActiveUri(items[1]!.uri)}
              />
              <CollageCell
                uri={items[2]!.uri}
                width={rightWidth}
                height={rightCellHeight}
                borderRadius={cellBorderRadius}
                imageIndex={2}
                onPress={() => setActiveUri(items[2]!.uri)}
              />
            </View>
          </View>
        );
      }

      if (count === 4) {
        const cellWidth = collageCellWidth(width, 2);
        const cellHeight = rowHeight;
        return (
          <View style={[styles.wrap, { gap: GAP, width }]}>
            {items.map((item, index) => (
              <CollageCell
                key={item.id}
                uri={item.uri}
                width={cellWidth}
                height={cellHeight}
                borderRadius={cellBorderRadius}
                imageIndex={index}
                onPress={() => setActiveUri(item.uri)}
              />
            ))}
          </View>
        );
      }

      const topRowHeight = rowHeight * 2;
      const topCellWidth = collageCellWidth(width, 2);
      const restCellWidth = collageCellWidth(width, 2);
      const restCellHeight = rowHeight;
      const rest = items.slice(2);

      return (
        <View style={{ gap: GAP, width }}>
          <View style={[styles.row, { gap: GAP, width }]}>
            {items.slice(0, 2).map((item, index) => (
              <CollageCell
                key={item.id}
                uri={item.uri}
                width={topCellWidth}
                height={topRowHeight}
                borderRadius={cellBorderRadius}
                imageIndex={index}
                onPress={() => setActiveUri(item.uri)}
              />
            ))}
          </View>
          <View style={[styles.wrap, { gap: GAP, width }]}>
            {rest.map((item, index) => (
              <CollageCell
                key={item.id}
                uri={item.uri}
                width={restCellWidth}
                height={restCellHeight}
                borderRadius={cellBorderRadius}
                imageIndex={index + 2}
                onPress={() => setActiveUri(item.uri)}
              />
            ))}
          </View>
        </View>
      );
    })();

    return (
      <View style={[styles.collage, collageBorderRadius > 0 ? { borderRadius: collageBorderRadius } : null]}>
        {collage}
      </View>
    );
  };

  return (
    <>
      <View
        style={[
          styles.wrapOuter,
          messageMode
            ? messageSingleFill
              ? messageImageAlign === "end"
                ? styles.wrapOuterMessageEnd
                : styles.wrapOuterMessageStart
              : { width }
            : styles.wrapOuterFullWidth,
          marginBottom > 0 ? { marginBottom } : null,
        ]}
        onLayout={messageMode || layout?.fixedWidth ? undefined : onLayout}
      >
        {renderCollage()}
      </View>

      {activeUri != null ? (
        <Modal visible transparent animationType="fade" onRequestClose={closeModal}>
          <Pressable
            style={[styles.modalBackdrop, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}
            onPress={closeModal}
          >
            <Pressable style={styles.modalContent} onPress={closeModal}>
              <ModalFrcImage uri={activeUri} />
            </Pressable>
          </Pressable>
        </Modal>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  wrapOuter: {
    alignSelf: "flex-start",
  },
  wrapOuterFullWidth: {
    width: "100%",
  },
  wrapOuterMessageStart: {
    alignSelf: "flex-start",
  },
  wrapOuterMessageEnd: {
    alignSelf: "flex-end",
  },
  collage: {
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
  },
  wrap: {
    flexDirection: "row",
    flexWrap: "wrap",
  },
  cell: {
    backgroundColor: "rgba(250, 250, 250, 0.05)",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.85)",
    paddingHorizontal: 16,
    justifyContent: "center",
    alignItems: "center",
  },
  modalContent: {
    width: "100%",
    height: "100%",
    justifyContent: "center",
    alignItems: "center",
  },
  modalClip: {
    width: "100%",
    height: "100%",
    overflow: "hidden",
  },
  modalImage: {
    width: "100%",
    height: "100%",
  },
});

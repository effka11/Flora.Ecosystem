import type { MsgConversationDto } from "@flora/client-core/contracts";
import type { ChatListFolderId } from "@flora/client-core/messaging";
import { chatListFolderPageIndex } from "@flora/client-core/messaging";
import { FlashList } from "@shopify/flash-list";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import {
  ActivityIndicator,
  RefreshControl,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Reanimated, {
  cancelAnimation,
  runOnJS,
  runOnUI,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { ConversationListRow } from "@/components/messages/ConversationListRow";
import {
  ENERGETIC_OPEN_EASING,
  ENERGETIC_OPEN_MS,
  settleEnergetic,
  snapPagerOffset,
} from "@/lib/energeticSettle";
import { floraColors, floraSpacing } from "@/lib/theme";

/** Как SWIPE_AXIS_PX у drawer / feed pager — не перехватывать вертикальный скролл. */
const PAGER_AXIS_PX = 10;
export type MessagesFolderConversationRow = MsgConversationDto & { preview: string };

export type MessagesFolderPagerHandle = {
  /** Как `switchKind` на ленте: целевой индекс + cancel предыдущего settle. */
  selectFolder: (folder: ChatListFolderId) => void;
};

type FolderOption = { id: string; label: string };

type Props = {
  pages: readonly ChatListFolderId[];
  activeFolder: ChatListFolderId;
  onActiveFolderChange: (folder: ChatListFolderId) => void;
  /** Общий с иконками папок — как scrollX подвкладок ленты. */
  scrollX: SharedValue<number>;
  pageWidthSV: SharedValue<number>;
  /** Тап назад в «all»: chrome гаснет на исходной иконке. */
  returnFromPageSV: SharedValue<number>;
  returnProgressSV: SharedValue<number>;
  dataByPage: ReadonlyMap<ChatListFolderId, readonly MessagesFolderConversationRow[]>;
  listPaddingBottom: number;
  refreshing: boolean;
  onRefresh: () => void;
  loading: boolean;
  error: boolean;
  emptyMessage: (folder: ChatListFolderId) => string;
  mutedByPeer: Readonly<Record<string, true>>;
  archivedByPeer: Readonly<Record<string, true>>;
  folderOptions: readonly FolderOption[];
  onMuteForever: (peerUuid: string, conversationUuid: string) => void;
  onMuteTemporary: (peerUuid: string, conversationUuid: string) => void;
  onUnmute: (peerUuid: string, conversationUuid: string) => void;
  onArchivedChange: (peerUuid: string, conversationUuid: string, archived: boolean) => void;
  onAddToFolder: (folderId: string, peerUuid: string) => void;
};

type PageListProps = {
  folder: ChatListFolderId;
  pageWidth: number;
  data: readonly MessagesFolderConversationRow[];
  listPaddingBottom: number;
  refreshing: boolean;
  onRefresh: () => void;
  loading: boolean;
  error: boolean;
  emptyText: string;
  mutedByPeer: Readonly<Record<string, true>>;
  archivedByPeer: Readonly<Record<string, true>>;
  folderOptions: readonly FolderOption[];
  onMuteForever: (peerUuid: string, conversationUuid: string) => void;
  onMuteTemporary: (peerUuid: string, conversationUuid: string) => void;
  onUnmute: (peerUuid: string, conversationUuid: string) => void;
  onArchivedChange: (peerUuid: string, conversationUuid: string, archived: boolean) => void;
  onAddToFolder: (folderId: string, peerUuid: string) => void;
};

const FolderPageList = memo(function FolderPageList({
  folder: _folder,
  pageWidth,
  data,
  listPaddingBottom,
  refreshing,
  onRefresh,
  loading,
  error,
  emptyText,
  mutedByPeer,
  archivedByPeer,
  folderOptions,
  onMuteForever,
  onMuteTemporary,
  onUnmute,
  onArchivedChange,
  onAddToFolder,
}: PageListProps) {
  const mutedRef = useRef(mutedByPeer);
  const archivedRef = useRef(archivedByPeer);
  const foldersRef = useRef(folderOptions);
  const onMuteForeverRef = useRef(onMuteForever);
  const onMuteTemporaryRef = useRef(onMuteTemporary);
  const onUnmuteRef = useRef(onUnmute);
  const onArchivedRef = useRef(onArchivedChange);
  const onAddRef = useRef(onAddToFolder);
  mutedRef.current = mutedByPeer;
  archivedRef.current = archivedByPeer;
  foldersRef.current = folderOptions;
  onMuteForeverRef.current = onMuteForever;
  onMuteTemporaryRef.current = onMuteTemporary;
  onUnmuteRef.current = onUnmute;
  onArchivedRef.current = onArchivedChange;
  onAddRef.current = onAddToFolder;

  const renderItem = useCallback(
    ({ item }: { item: MessagesFolderConversationRow }) => (
      <ConversationListRow
        item={item}
        isMuted={item.otherUserUuid in mutedRef.current}
        isArchived={item.otherUserUuid in archivedRef.current}
        folderOptions={foldersRef.current as FolderOption[]}
        onMuteForever={() =>
          onMuteForeverRef.current(item.otherUserUuid, item.conversationUuid)
        }
        onMuteTemporary={() =>
          onMuteTemporaryRef.current(item.otherUserUuid, item.conversationUuid)
        }
        onUnmute={() => onUnmuteRef.current(item.otherUserUuid, item.conversationUuid)}
        onArchivedChange={(archived) =>
          onArchivedRef.current(item.otherUserUuid, item.conversationUuid, archived)
        }
        onAddToFolder={(folderId) => onAddRef.current(folderId, item.otherUserUuid)}
      />
    ),
    [],
  );

  const listEmpty = useMemo(() => {
    if (loading) {
      return (
        <View style={styles.loading}>
          <ActivityIndicator color={floraColors.greenLight} />
          <Text style={styles.emptyHint}>Загрузка чатов…</Text>
        </View>
      );
    }
    if (error) {
      return <Text style={styles.emptyHint}>Не удалось загрузить чаты.</Text>;
    }
    return <Text style={styles.emptyHint}>{emptyText}</Text>;
  }, [emptyText, error, loading]);

  const contentStyle = useMemo(
    () => [styles.listContent, { paddingBottom: listPaddingBottom }],
    [listPaddingBottom],
  );

  return (
    <View style={[styles.page, { width: pageWidth }]} collapsable={false}>
      <FlashList
        data={data as MessagesFolderConversationRow[]}
        keyExtractor={(item) => item.conversationUuid}
        contentContainerStyle={contentStyle}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={floraColors.greenLight}
          />
        }
        renderItem={renderItem}
        ListEmptyComponent={listEmpty}
        extraData={`${Object.keys(mutedByPeer).join(",")}|${Object.keys(archivedByPeer).join(",")}|${folderOptions.length}`}
      />
    </View>
  );
});

export const MessagesFolderPager = forwardRef<MessagesFolderPagerHandle, Props>(
  function MessagesFolderPager(
    {
      pages,
      activeFolder,
      onActiveFolderChange,
      scrollX,
      pageWidthSV,
      returnFromPageSV,
      returnProgressSV,
      dataByPage,
      listPaddingBottom,
      refreshing,
      onRefresh,
      loading,
      error,
      emptyMessage,
      mutedByPeer,
      archivedByPeer,
      folderOptions,
      onMuteForever,
      onMuteTemporary,
      onUnmute,
      onArchivedChange,
      onAddToFolder,
    },
    ref,
  ) {
    const { width: pageWidth } = useWindowDimensions();
    const dragStartX = useSharedValue(0);
    const pageCountSV = useSharedValue(Math.max(1, pages.length));
    /** Последний запрошенный индекс (UI-thread), как цель settle. */
    const targetIndexSV = useSharedValue(0);

    const pagesRef = useRef(pages);
    const pagesKey = pages.join("|");
    /** Как `pagerTargetRef` на ленте — игнор повторных тапов в ту же цель. */
    const pagerTargetRef = useRef<ChatListFolderId>(activeFolder);

    pagesRef.current = pages;

    const jumpToIndex = useCallback(
      (index: number) => {
        const width = pageWidth;
        const count = Math.max(1, pagesRef.current.length);
        const safe = Math.max(0, Math.min(count - 1, index));
        cancelAnimation(scrollX);
        cancelAnimation(returnProgressSV);
        returnFromPageSV.value = 0;
        returnProgressSV.value = 0;
        pageWidthSV.value = width;
        pageCountSV.value = count;
        targetIndexSV.value = safe;
        scrollX.value = safe * width;
      },
      [
        pageCountSV,
        pageWidth,
        pageWidthSV,
        returnFromPageSV,
        returnProgressSV,
        scrollX,
        targetIndexSV,
      ],
    );

    useEffect(() => {
      const index = chatListFolderPageIndex(pages, pagerTargetRef.current);
      jumpToIndex(index);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- topology / rotate only
    }, [pageWidth, pagesKey]);

    const commitPageIndex = useCallback(
      (index: number) => {
        const folder = pagesRef.current[index] ?? "all";
        // Устаревший settle после cancel/быстрых тапов — цель уже другая.
        if (pagerTargetRef.current !== folder) return;
        onActiveFolderChange(folder);
      },
      [onActiveFolderChange],
    );

    const clearReturnChrome = useCallback(() => {
      "worklet";
      cancelAnimation(returnProgressSV);
      returnFromPageSV.value = 0;
      returnProgressSV.value = 0;
    }, [returnFromPageSV, returnProgressSV]);

    const selectFolder = useCallback(
      (folder: ChatListFolderId) => {
        // Паритет feed `switchKind`: повтор в ту же цель — no-op.
        // Иконки/underline уже на UI-thread от scrollX — React state только после settle
        // (иначе FlashList'ы перерисовываются в середине анимации).
        if (folder === pagerTargetRef.current) return;

        const pagesNow = pagesRef.current;
        const prevIndex = chatListFolderPageIndex(pagesNow, pagerTargetRef.current);
        const nextIndex = chatListFolderPageIndex(pagesNow, folder);
        pagerTargetRef.current = folder;

        runOnUI(() => {
          "worklet";
          cancelAnimation(scrollX);
          cancelAnimation(returnProgressSV);
          const width = pageWidthSV.value;
          const count = pageCountSV.value;
          if (width <= 0 || count <= 0) return;

          const targetIndex = Math.max(0, Math.min(count - 1, nextIndex));
          const target = targetIndex * width;
          const indexDelta = targetIndex - prevIndex;

          // Тап all↔иконка: список — короткий settle; chrome fade на якоре
          // (не едет underline/цвет через промежуточные индексы).
          const fromAll = prevIndex === 0 && targetIndex > 0;
          const toAll = targetIndex === 0 && prevIndex > 0;
          if (fromAll || toAll) {
            const anchor = toAll ? prevIndex : targetIndex;
            const progressFrom = toAll ? 1 : 0;
            const progressTo = toAll ? 0 : 1;

            returnFromPageSV.value = anchor;
            returnProgressSV.value = progressFrom;

            if (Math.abs(indexDelta) > 1) {
              const direction = indexDelta > 0 ? 1 : -1;
              scrollX.value = target - direction * width;
            }

            targetIndexSV.value = targetIndex;
            settleEnergetic(
              scrollX,
              target,
              width,
              1,
              0,
              ENERGETIC_OPEN_MS,
              ENERGETIC_OPEN_EASING,
              (finished) => {
                if (finished) runOnJS(commitPageIndex)(targetIndex);
              },
            );
            returnProgressSV.value = withTiming(
              progressTo,
              { duration: ENERGETIC_OPEN_MS, easing: ENERGETIC_OPEN_EASING },
              (finished) => {
                if (finished) {
                  // Handoff на scrollX (уже на target) — без мигания.
                  returnFromPageSV.value = 0;
                  returnProgressSV.value = 0;
                }
              },
            );
            return;
          }

          returnFromPageSV.value = 0;
          returnProgressSV.value = 0;

          // Дальше соседней: телепорт на соседнюю с нужной стороны (скорость = 1 страница).
          if (Math.abs(indexDelta) > 1) {
            const direction = indexDelta > 0 ? 1 : -1;
            scrollX.value = target - direction * width;
          }

          targetIndexSV.value = targetIndex;
          settleEnergetic(
            scrollX,
            target,
            width,
            1,
            0,
            ENERGETIC_OPEN_MS,
            ENERGETIC_OPEN_EASING,
            (finished) => {
              // finished=false при cancel — новый selectFolder/pan уже ведёт.
              if (finished) runOnJS(commitPageIndex)(targetIndex);
            },
          );
        })();
      },
      [
        commitPageIndex,
        pageCountSV,
        pageWidthSV,
        returnFromPageSV,
        returnProgressSV,
        scrollX,
        targetIndexSV,
      ],
    );

    useImperativeHandle(ref, () => ({ selectFolder }), [selectFolder]);

    // Внешняя нормализация (архив опустел и т.п.) — без двойной анимации из useEffect-цепочки.
    useEffect(() => {
      if (activeFolder === pagerTargetRef.current) return;
      selectFolder(activeFolder);
    }, [activeFolder, selectFolder]);

    /** Pan выбрал индекс — только цель (без setState), commit после settle. */
    const preparePanTarget = useCallback((index: number) => {
      pagerTargetRef.current = pagesRef.current[index] ?? "all";
    }, []);

    const pagerPan = useMemo(
      () =>
        Gesture.Pan()
          .activeOffsetX([-PAGER_AXIS_PX, PAGER_AXIS_PX])
          .failOffsetY([-PAGER_AXIS_PX * 2, PAGER_AXIS_PX * 2])
          .onStart(() => {
            "worklet";
            cancelAnimation(scrollX);
            clearReturnChrome();
            dragStartX.value = scrollX.value;
          })
          .onUpdate((event) => {
            "worklet";
            const width = pageWidthSV.value;
            const count = pageCountSV.value;
            if (width <= 0 || count <= 0) return;
            const maxOffset = Math.max(0, count - 1) * width;
            scrollX.value = Math.max(
              0,
              Math.min(maxOffset, dragStartX.value - event.translationX),
            );
          })
          .onEnd((event) => {
            "worklet";
            const width = pageWidthSV.value;
            const count = pageCountSV.value;
            if (width <= 0 || count <= 0) return;
            const target = snapPagerOffset(scrollX.value, width, count, event.velocityX);
            const targetIndex = Math.round(target / width);
            targetIndexSV.value = targetIndex;
            runOnJS(preparePanTarget)(targetIndex);
            settleEnergetic(
              scrollX,
              target,
              width,
              1,
              event.velocityX,
              ENERGETIC_OPEN_MS,
              ENERGETIC_OPEN_EASING,
              (finished) => {
                if (finished) runOnJS(commitPageIndex)(targetIndex);
              },
            );
          }),
      [
        clearReturnChrome,
        commitPageIndex,
        dragStartX,
        pageCountSV,
        pageWidthSV,
        preparePanTarget,
        scrollX,
        targetIndexSV,
      ],
    );

    const pagerStyle = useAnimatedStyle(() => ({
      transform: [{ translateX: -scrollX.value }],
    }));

    return (
      <View style={styles.body}>
        <GestureDetector gesture={pagerPan}>
          <Reanimated.View
            style={[
              styles.pagerRow,
              { width: Math.max(pageWidth, pageWidth * Math.max(pages.length, 1)) },
              pagerStyle,
            ]}
          >
            {pages.map((folder) => (
              <FolderPageList
                key={folder}
                folder={folder}
                pageWidth={pageWidth}
                data={dataByPage.get(folder) ?? []}
                listPaddingBottom={listPaddingBottom}
                refreshing={refreshing}
                onRefresh={onRefresh}
                loading={loading}
                error={error}
                emptyText={emptyMessage(folder)}
                mutedByPeer={mutedByPeer}
                archivedByPeer={archivedByPeer}
                folderOptions={folderOptions}
                onMuteForever={onMuteForever}
                onMuteTemporary={onMuteTemporary}
                onUnmute={onUnmute}
                onArchivedChange={onArchivedChange}
                onAddToFolder={onAddToFolder}
              />
            ))}
          </Reanimated.View>
        </GestureDetector>
      </View>
    );
  },
);

const styles = StyleSheet.create({
  body: {
    flex: 1,
    overflow: "hidden",
  },
  pagerRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "stretch",
  },
  page: {
    flex: 1,
    alignSelf: "stretch",
  },
  listContent: {},
  loading: {
    alignItems: "center",
    gap: floraSpacing.grid,
    paddingVertical: floraSpacing.grid * 3,
  },
  emptyHint: {
    color: floraColors.gray,
    textAlign: "center",
    marginTop: floraSpacing.grid * 3,
    paddingHorizontal: floraSpacing.grid * 2,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
});

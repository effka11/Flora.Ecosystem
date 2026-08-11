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
import { GroupConversationListRow } from "@/components/messages/GroupConversationListRow";
import type { GroupChat } from "@/lib/groupChatTypes";
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

export type MessagesFolderListRow =
  | { kind: "dm"; item: MessagesFolderConversationRow }
  | { kind: "groupChat"; group: GroupChat; preview: string };

export type MessagesFolderPagerHandle = {
  /** Как `switchKind` на ленте: целевой индекс + cancel предыдущего settle. */
  selectFolder: (folder: ChatListFolderId) => void;
};

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
  dataByPage: ReadonlyMap<ChatListFolderId, readonly MessagesFolderListRow[]>;
  listPaddingBottom: number;
  refreshing: boolean;
  onRefresh: () => void;
  loading: boolean;
  error: boolean;
  emptyMessage: (folder: ChatListFolderId) => string;
  selectionMode: boolean;
  selectedConversationUuids: ReadonlySet<string>;
  onEnterSelect: (conversationUuid: string) => void;
  onToggleSelect: (conversationUuid: string) => void;
};

type PageListProps = {
  folder: ChatListFolderId;
  pageWidth: number;
  data: readonly MessagesFolderListRow[];
  listPaddingBottom: number;
  refreshing: boolean;
  onRefresh: () => void;
  loading: boolean;
  error: boolean;
  emptyText: string;
  selectionMode: boolean;
  selectedConversationUuids: ReadonlySet<string>;
  onEnterSelect: (conversationUuid: string) => void;
  onToggleSelect: (conversationUuid: string) => void;
  /** Active folder: overScroll `auto` + refreshing; RC stays mounted on all pages. */
  ptrEnabled: boolean;
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
  selectionMode,
  selectedConversationUuids,
  onEnterSelect,
  onToggleSelect,
  ptrEnabled,
}: PageListProps) {
  const onEnterRef = useRef(onEnterSelect);
  const onToggleRef = useRef(onToggleSelect);
  onEnterRef.current = onEnterSelect;
  onToggleRef.current = onToggleSelect;

  const renderItem = useCallback(
    ({ item }: { item: MessagesFolderListRow }) => {
      if (item.kind === "groupChat") {
        const uuid = item.group.conversationUuid;
        return (
          <GroupConversationListRow
            group={item.group}
            preview={item.preview}
            selectionMode={selectionMode}
            selected={selectedConversationUuids.has(uuid)}
            onEnterSelect={() => onEnterRef.current(uuid)}
            onToggleSelect={() => onToggleRef.current(uuid)}
          />
        );
      }
      const row = item.item;
      const uuid = row.conversationUuid;
      return (
        <ConversationListRow
          item={row}
          selectionMode={selectionMode}
          selected={selectedConversationUuids.has(uuid)}
          onEnterSelect={() => onEnterRef.current(uuid)}
          onToggleSelect={() => onToggleRef.current(uuid)}
        />
      );
    },
    [selectionMode, selectedConversationUuids],
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
        data={data as MessagesFolderListRow[]}
        keyExtractor={(item) =>
          item.kind === "groupChat" ? `g:${item.group.conversationUuid}` : item.item.conversationUuid
        }
        contentContainerStyle={contentStyle}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled={false}
        overScrollMode={ptrEnabled ? "auto" : "never"}
        refreshControl={
          <RefreshControl
            refreshing={ptrEnabled && refreshing}
            onRefresh={onRefresh}
            tintColor={floraColors.greenLight}
          />
        }
        renderItem={renderItem}
        ListEmptyComponent={listEmpty}
        extraData={`${selectionMode ? "1" : "0"}|${[...selectedConversationUuids].join(",")}`}
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
      selectionMode,
      selectedConversationUuids,
      onEnterSelect,
      onToggleSelect,
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

    // Topology / rotate: sync count+width. If current page folder still exists —
    // reposition to its index (width change). If Архив (etc.) vanished under the
    // finger — soft-clamp offset only; `activeFolder`→selectFolder settles after.
    useEffect(() => {
      const count = Math.max(1, pages.length);
      pageCountSV.value = count;
      pageWidthSV.value = pageWidth;
      const target = pagerTargetRef.current;
      if (pages.includes(target)) {
        jumpToIndex(chatListFolderPageIndex(pages, target));
        return;
      }
      runOnUI(() => {
        "worklet";
        const width = pageWidthSV.value;
        if (width <= 0) return;
        const maxOffset = Math.max(0, count - 1) * width;
        if (scrollX.value > maxOffset) {
          scrollX.value = maxOffset;
          targetIndexSV.value = Math.max(0, count - 1);
        }
      })();
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
                selectionMode={selectionMode}
                selectedConversationUuids={selectedConversationUuids}
                onEnterSelect={onEnterSelect}
                onToggleSelect={onToggleSelect}
                ptrEnabled={folder === activeFolder}
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

import type { MsgConversationDto } from "@flora/client-core/contracts";
import type { ChatListFolderId } from "@flora/client-core/messaging";
import { chatListFolderPageIndex } from "@flora/client-core/messaging";
import { FlashList } from "@shopify/flash-list";
import { useFocusEffect } from "expo-router/react-navigation";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type ScrollViewProps,
} from "react-native";
import { Gesture, RefreshControl } from "react-native-gesture-handler";
import {
  cancelAnimation,
  runOnJS,
  runOnUI,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { TabPagerPage, TabPagerTrack } from "@/components/chrome/TabPager";
import { ConversationListRow } from "@/components/messages/ConversationListRow";
import { GroupConversationListRow } from "@/components/messages/GroupConversationListRow";
import { MAX_PAGER_PAGES } from "@/components/messages/messagesFolderPagerScroll";
import type { GroupChat } from "@/lib/groupChatTypes";
import {
  ENERGETIC_OPEN_EASING,
  ENERGETIC_OPEN_MS,
  settleEnergetic,
  snapPagerOffset,
} from "@/lib/energeticSettle";
import { nextFeedPageWidth } from "@/lib/feedImageGeometry";
import { imeStableWindowWidth, isImeVisible } from "@/lib/imeVisible";
import { floraColors, floraSpacing } from "@/lib/theme";
import { useDeferredPagerMount } from "@/lib/useDeferredPagerMount";
import { usePagerBusyFlags } from "@/lib/usePagerBusyFlags";
import { usePagerListScroll } from "@/lib/usePagerListScroll";
import { PAGER_AXIS_PX } from "@/lib/useTabPager";

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
  /** Начало горизонтального pan — закрыть поиск в шапке. */
  onPanStart?: () => void;
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
  /** Active folder: refreshing; RC stays mounted on all pages. */
  ptrEnabled: boolean;
  onScrollBeginDrag?: () => void;
  renderScrollComponent: ComponentType<ScrollViewProps>;
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
  onScrollBeginDrag,
  renderScrollComponent,
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
    <TabPagerPage pageWidth={pageWidth}>
      <FlashList
        data={data as MessagesFolderListRow[]}
        keyExtractor={(item) =>
          item.kind === "groupChat" ? `g:${item.group.conversationUuid}` : item.item.conversationUuid
        }
        contentContainerStyle={contentStyle}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled={false}
        keyboardDismissMode="on-drag"
        onScrollBeginDrag={onScrollBeginDrag}
        drawDistance={ptrEnabled ? 250 : 0}
        renderScrollComponent={renderScrollComponent}
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
    </TabPagerPage>
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
      onPanStart,
    },
    ref,
  ) {
    const [pageWidth, setPageWidth] = useState(imeStableWindowWidth);
    const dragStartX = useSharedValue(0);
    const pageCountSV = useSharedValue(Math.max(1, pages.length));
    /** Последний запрошенный индекс (UI-thread), как цель settle. */
    const targetIndexSV = useSharedValue(0);
    const { renderScrollComponents, setActivePane } = usePagerListScroll(MAX_PAGER_PAGES);
    const [tabFocused, setTabFocused] = useState(false);
    useFocusEffect(
      useCallback(() => {
        setTabFocused(true);
        return () => setTabFocused(false);
      }, []),
    );
    const { mountedIds, setBusy, ensureMounted, onCommitted } = useDeferredPagerMount(
      pages,
      0,
      tabFocused,
    );
    const pagerGenRef = useRef(0);
    const panActivatedRef = useRef(false);
    const panSetPagerRef = useRef(false);
    const { reportTouch, reportPager, getEpoch, isBusy } = usePagerBusyFlags(setBusy);
    const onPanStartRef = useRef(onPanStart);
    onPanStartRef.current = onPanStart;

    const pagesRef = useRef(pages);
    const pagesKey = pages.join("|");
    /** Как `pagerTargetRef` на ленте — игнор повторных тапов в ту же цель. */
    const pagerTargetRef = useRef<ChatListFolderId>(activeFolder);

    pagesRef.current = pages;

    const onBodyLayout = useCallback((event: LayoutChangeEvent) => {
      const w = event.nativeEvent.layout.width;
      setPageWidth((prev) => nextFeedPageWidth(prev, w, isImeVisible()));
    }, []);

    useEffect(() => {
      const prev = pageWidthSV.value;
      pageWidthSV.value = pageWidth;
      if (prev > 0 && pageWidth > 0 && prev !== pageWidth) {
        scrollX.value = scrollX.value * (pageWidth / prev);
      }
    }, [pageWidth, pageWidthSV, scrollX]);

    const jumpToIndex = useCallback(
      (index: number) => {
        runOnUI((safeIndex: number) => {
          "worklet";
          cancelAnimation(scrollX);
          cancelAnimation(returnProgressSV);
          returnFromPageSV.value = 0;
          returnProgressSV.value = 0;
          const width = pageWidthSV.value;
          const count = pageCountSV.value;
          const maxIndex = Math.max(0, count - 1);
          const safe = Math.max(0, Math.min(maxIndex, safeIndex));
          targetIndexSV.value = safe;
          if (width > 0) scrollX.value = safe * width;
        })(index);
      },
      [pageCountSV, pageWidthSV, returnFromPageSV, returnProgressSV, scrollX, targetIndexSV],
    );

    // Topology / rotate: sync count. If current page folder still exists —
    // reposition to its index. If Архив (etc.) vanished under the
    // finger — soft-clamp offset only; `activeFolder`→selectFolder settles after.
    useEffect(() => {
      const count = Math.max(1, pages.length);
      pageCountSV.value = count;
      if (isBusy()) return;
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
      // eslint-disable-next-line react-hooks/exhaustive-deps -- topology only
    }, [pagesKey]);

    const commitPageIndex = useCallback(
      (index: number) => {
        const folder = pagesRef.current[index] ?? "all";
        // Устаревший settle после cancel/быстрых тапов — цель уже другая.
        if (pagerTargetRef.current !== folder) return;
        setActivePane(index);
        onActiveFolderChange(folder);
        onCommitted(index);
      },
      [onActiveFolderChange, onCommitted, setActivePane],
    );

    const finishFolderSettle = useCallback(
      (index: number, finished: boolean, gen: number) => {
        if (finished !== true) return;
        if (gen === pagerGenRef.current) {
          panSetPagerRef.current = false;
          panActivatedRef.current = false;
        }
        reportPager(false, gen);
        commitPageIndex(index);
      },
      [commitPageIndex, reportPager],
    );

    const syncActivePane = useCallback(() => {
      setActivePane(chatListFolderPageIndex(pagesRef.current, pagerTargetRef.current));
    }, [setActivePane]);
    useEffect(() => {
      syncActivePane();
    }, [syncActivePane, pagesKey, activeFolder]);
    useFocusEffect(syncActivePane);

    const clearReturnChrome = useCallback(() => {
      "worklet";
      cancelAnimation(returnProgressSV);
      returnFromPageSV.value = 0;
      returnProgressSV.value = 0;
    }, [returnFromPageSV, returnProgressSV]);

    const runSelectFolderSettle = useCallback(
      (prevIndex: number, nextIndex: number, gen: number) => {
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
                runOnJS(finishFolderSettle)(targetIndex, finished === true, gen);
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
              runOnJS(finishFolderSettle)(targetIndex, finished === true, gen);
            },
          );
        })();
      },
      [
        finishFolderSettle,
        pageCountSV,
        pageWidthSV,
        returnFromPageSV,
        returnProgressSV,
        scrollX,
        targetIndexSV,
      ],
    );

    const selectFolder = useCallback(
      (folder: ChatListFolderId) => {
        // Паритет feed `switchKind`: повтор в ту же цель — no-op.
        // Иконки/underline уже на UI-thread от scrollX — React state только после settle
        // (иначе FlashList'ы перерисовываются в середине анимации).
        if (folder === pagerTargetRef.current) return;

        const pagesNow = pagesRef.current;
        const prevFolder = pagerTargetRef.current;
        const prevIndex = chatListFolderPageIndex(pagesNow, prevFolder);
        const nextIndex = chatListFolderPageIndex(pagesNow, folder);
        pagerTargetRef.current = folder;
        const gen = reportPager(true);
        pagerGenRef.current = gen;
        onPanStartRef.current?.();
        const epochAtTap = getEpoch();

        let needsMount = false;
        const targetId = pagesNow[nextIndex];
        if (targetId != null) needsMount = ensureMounted(targetId) || needsMount;
        if (Math.abs(nextIndex - prevIndex) > 1) {
          const neighborIndex = nextIndex - Math.sign(nextIndex - prevIndex);
          const neighborId = pagesNow[neighborIndex];
          if (neighborId != null) needsMount = ensureMounted(neighborId) || needsMount;
        }

        const go = () => {
          if (pagerTargetRef.current !== folder) return;
          if (getEpoch() !== epochAtTap) {
            pagerTargetRef.current = prevFolder;
            reportPager(false, gen);
            return;
          }
          runSelectFolderSettle(prevIndex, nextIndex, gen);
        };
        if (needsMount) requestAnimationFrame(go);
        else go();
      },
      [ensureMounted, getEpoch, reportPager, runSelectFolderSettle],
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

    const beginFolderTouch = useCallback(() => {
      panActivatedRef.current = false;
      panSetPagerRef.current = false;
      reportTouch(true);
      onPanStartRef.current?.();
    }, [reportTouch]);

    const endFolderTouch = useCallback(() => {
      reportTouch(false);
    }, [reportTouch]);

    const markPanActivated = useCallback(() => {
      panActivatedRef.current = true;
    }, []);

    const failPagerIfNeeded = useCallback(() => {
      if (!panSetPagerRef.current && !panActivatedRef.current) return;
      panSetPagerRef.current = false;
      panActivatedRef.current = false;
      reportPager(false, pagerGenRef.current);
    }, [reportPager]);

    const beginPanSettle = useCallback(
      (targetIndex: number, target: number, width: number, velocityX: number) => {
        panSetPagerRef.current = true;
        const gen = reportPager(true);
        pagerGenRef.current = gen;
        preparePanTarget(targetIndex);
        runOnUI(() => {
          "worklet";
          settleEnergetic(
            scrollX,
            target,
            width,
            1,
            velocityX,
            ENERGETIC_OPEN_MS,
            ENERGETIC_OPEN_EASING,
            (finished) => {
              runOnJS(finishFolderSettle)(targetIndex, finished === true, gen);
            },
          );
        })();
      },
      [finishFolderSettle, preparePanTarget, reportPager, scrollX],
    );

    const pagerPan = useMemo(
      () =>
        Gesture.Pan()
          .activeOffsetX([-PAGER_AXIS_PX, PAGER_AXIS_PX])
          .failOffsetY([-PAGER_AXIS_PX * 2, PAGER_AXIS_PX * 2])
          .onBegin(() => {
            "worklet";
            runOnJS(beginFolderTouch)();
          })
          .onStart(() => {
            "worklet";
            cancelAnimation(scrollX);
            clearReturnChrome();
            dragStartX.value = scrollX.value;
            runOnJS(markPanActivated)();
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
            runOnJS(beginPanSettle)(targetIndex, target, width, event.velocityX);
          })
          .onFinalize((_event, success) => {
            "worklet";
            runOnJS(endFolderTouch)();
            if (!success) runOnJS(failPagerIfNeeded)();
          }),
      [
        beginFolderTouch,
        beginPanSettle,
        clearReturnChrome,
        dragStartX,
        endFolderTouch,
        failPagerIfNeeded,
        markPanActivated,
        pageCountSV,
        pageWidthSV,
        scrollX,
        targetIndexSV,
      ],
    );

    const pageCount = Math.max(1, pages.length);

    return (
      <View style={styles.body} onLayout={onBodyLayout}>
        <TabPagerTrack
          pageCount={pageCount}
          pageWidth={pageWidth}
          pagerPan={pagerPan}
          scrollX={scrollX}
        >
          {pages.map((folder, index) => {
            const scroll = renderScrollComponents[index];
            if (!mountedIds.has(folder) || scroll == null) {
              return <TabPagerPage key={folder} pageWidth={pageWidth} />;
            }
            return (
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
                onScrollBeginDrag={onPanStart}
                renderScrollComponent={scroll}
              />
            );
          })}
        </TabPagerTrack>
      </View>
    );
  },
);

const styles = StyleSheet.create({
  body: {
    flex: 1,
    overflow: "hidden",
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

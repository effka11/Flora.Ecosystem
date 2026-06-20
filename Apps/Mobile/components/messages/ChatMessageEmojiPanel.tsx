import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import {
  MESSAGE_EMOJI_CATEGORIES,
  type EmojiCategoryId,
} from "@/lib/messages/emojiCategories";
import {
  MOBILE_EMOJI_CELL_GAP,
  MOBILE_EMOJI_CELL_SIZE,
  MOBILE_EMOJI_GRID_COLS,
  buildEmojiGridSections,
  emojiSectionIndex,
  type EmojiGridRow,
  type EmojiGridSection,
} from "@/lib/messages/emojiGrid";
import { FLORA_THEME_TOKENS } from "@flora/client-core/display";
import { floraColors, floraMessages, floraSpacing } from "@/lib/theme";

const FLORA_GITHUB_URL = "https://github.com/effka11/Flora.Ecosystem";

type StickerPanelTab = "emoji" | "stickers";

type ListItem =
  | { type: "header"; section: EmojiGridSection }
  | { type: "row"; sectionId: EmojiCategoryId; row: EmojiGridRow };

type Props = {
  onPickEmoji: (emoji: string) => void;
};

function buildFlatItems(sections: EmojiGridSection[]): ListItem[] {
  const items: ListItem[] = [];
  for (const section of sections) {
    items.push({ type: "header", section });
    for (const row of section.data) {
      items.push({ type: "row", sectionId: section.id, row });
    }
  }
  return items;
}

function ChatMessageEmojiPanelInner({ onPickEmoji }: Props) {
  const [tab, setTab] = useState<StickerPanelTab>("emoji");
  const [activeCategory, setActiveCategory] = useState<EmojiCategoryId>("smileys_emotion");
  // Грид монтируем после кадра открытия панели — тяжёлый FlashList не должен блокировать JS-поток
  // во время анимации подъёма поля / скрытия клавиатуры. Рейл и вкладки показываем сразу.
  const [gridReady, setGridReady] = useState(false);
  const listRef = useRef<FlashListRef<ListItem>>(null);
  const railRef = useRef<ScrollView>(null);
  const sections = useMemo(() => buildEmojiGridSections(MESSAGE_EMOJI_CATEGORIES), []);
  const firstSectionId = sections[0]?.id;
  const flatItems = useMemo(() => buildFlatItems(sections), [sections]);
  const headerIndexes = useMemo(
    () =>
      flatItems
        .map((item, index) => (item.type === "header" ? index : -1))
        .filter((index) => index >= 0),
    [flatItems],
  );

  useEffect(() => {
    // Монтируем тяжёлый грид через 2 кадра после появления панели: чрома (рейл/вкладки)
    // рисуется сразу, а монтирование ~1900 эмодзи не блокирует кадр открытия.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setGridReady(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, []);

  const scrollToCategory = useCallback(
    (categoryId: EmojiCategoryId) => {
      setActiveCategory(categoryId);
      const sectionIndex = emojiSectionIndex(sections, categoryId);
      const flatIndex = headerIndexes[sectionIndex];
      if (flatIndex == null) return;
      listRef.current?.scrollToIndex({ index: flatIndex, animated: true });
      railRef.current?.scrollTo({ y: Math.max(0, sectionIndex * 44 - 60), animated: true });
    },
    [headerIndexes, sections],
  );

  const pickEmoji = useCallback(
    (emoji: string) => {
      onPickEmoji(emoji);
    },
    [onPickEmoji],
  );

  const syncCategoryFromViewable = useCallback(
    (startIndex: number) => {
      for (let i = startIndex; i >= 0; i--) {
        const item = flatItems[i];
        if (item?.type === "header") {
          if (item.section.id !== activeCategory) setActiveCategory(item.section.id);
          return;
        }
      }
    },
    [activeCategory, flatItems],
  );

  const renderItem = useCallback(
    ({ item }: { item: ListItem }) => {
      if (item.type === "header") {
        // Первая категория начинается сразу под полем — без разделителя.
        if (item.section.id === firstSectionId) {
          return <View style={styles.sectionLead} />;
        }
        return (
          <View style={styles.sectionDivider}>
            <View style={styles.sectionLine} />
          </View>
        );
      }

      return (
        <View style={styles.emojiRow}>
          {item.row.emojis.map((emoji) => (
            <Pressable
              key={emoji}
              accessibilityRole="button"
              accessibilityLabel={`Вставить ${emoji}`}
              style={({ pressed }) => [styles.emojiCell, pressed && styles.emojiCellPressed]}
              onPress={() => pickEmoji(emoji)}
            >
              <Text style={styles.emojiText}>{emoji}</Text>
            </Pressable>
          ))}
          {item.row.emojis.length < MOBILE_EMOJI_GRID_COLS
            ? Array.from({ length: MOBILE_EMOJI_GRID_COLS - item.row.emojis.length }).map((_, i) => (
                <View key={`spacer-${i}`} style={styles.emojiCellSpacer} />
              ))
            : null}
        </View>
      );
    },
    [firstSectionId, pickEmoji],
  );

  return (
    <View style={styles.panel}>
      <View style={[styles.rail, tab !== "emoji" && styles.railCollapsed]}>
        <ScrollView
          ref={railRef}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.railContent}
        >
          {sections.map((section) => {
            const selected = tab === "emoji" && activeCategory === section.id;
            return (
              <Pressable
                key={section.id}
                accessibilityRole="button"
                accessibilityLabel={section.label}
                accessibilityState={{ selected }}
                style={({ pressed }) => [
                  styles.railBtn,
                  selected && styles.railBtnActive,
                  pressed && styles.railBtnPressed,
                ]}
                onPress={() => {
                  setTab("emoji");
                  scrollToCategory(section.id);
                }}
              >
                <Text style={styles.railIcon}>{section.icon}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      <View style={styles.body}>
        <View style={styles.tabs} accessibilityRole="tablist">
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === "emoji" }}
            style={({ pressed }) => [
              styles.tab,
              tab === "emoji" && styles.tabActive,
              pressed && styles.tabPressed,
            ]}
            onPress={() => setTab("emoji")}
          >
            <Text style={[styles.tabText, tab === "emoji" && styles.tabTextActive]}>Эмодзи</Text>
          </Pressable>
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === "stickers" }}
            style={({ pressed }) => [
              styles.tab,
              tab === "stickers" && styles.tabActive,
              pressed && styles.tabPressed,
            ]}
            onPress={() => setTab("stickers")}
          >
            <Text style={[styles.tabText, tab === "stickers" && styles.tabTextActive]}>Стикеры</Text>
          </Pressable>
        </View>

        {tab === "emoji" ? (
          gridReady ? (
            <FlashList
              ref={listRef}
              style={styles.grid}
              data={flatItems}
              keyExtractor={(item, index) =>
                item.type === "header" ? `header-${item.section.id}` : `${item.sectionId}-${item.row.key}-${index}`
              }
              renderItem={renderItem}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.gridContent}
              onViewableItemsChanged={({ viewableItems }) => {
                const first = viewableItems[0]?.index;
                if (first != null) syncCategoryFromViewable(first);
              }}
            />
          ) : (
            <View style={styles.grid} />
          )
        ) : (
          <View style={styles.stickersPlaceholder}>
            <Text style={styles.stickersText}>
              Стикеры ещё в разработке. Следите за обновлениями на GitHub экосистемы FLORA.
            </Text>
            <Pressable
              accessibilityRole="link"
              onPress={() => void Linking.openURL(FLORA_GITHUB_URL)}
              style={({ pressed }) => [styles.stickersLinkWrap, pressed && styles.tabPressed]}
            >
              <Text style={styles.stickersLink}>GitHub</Text>
            </Pressable>
          </View>
        )}
      </View>
    </View>
  );
}

/** memo: панель тяжёлая (FlashList на ~1900 эмодзи); не перерисовываем при наборе текста/скролле. */
export const ChatMessageEmojiPanel = memo(ChatMessageEmojiPanelInner);

const styles = StyleSheet.create({
  panel: {
    flex: 1,
    flexDirection: "row",
    width: "100%",
    height: "100%",
    backgroundColor: floraColors.surfaceElevated,
    borderWidth: 1,
    borderColor: floraColors.greenBubble,
    overflow: "hidden",
  },
  rail: {
    width: 44,
    borderRightWidth: 1,
    borderRightColor: floraMessages.divider,
    backgroundColor: floraColors.popoverRail,
  },
  railCollapsed: {
    opacity: 0.45,
  },
  railContent: {
    paddingVertical: floraSpacing.gridFine,
    gap: floraSpacing.gridFine,
    alignItems: "center",
  },
  railBtn: {
    width: 36,
    height: 36,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  railBtnActive: {
    backgroundColor: FLORA_THEME_TOKENS.reservePopoverAccentSelected,
  },
  railBtnPressed: {
    opacity: 0.72,
  },
  railIcon: {
    fontSize: 20,
    lineHeight: 24,
  },
  body: {
    flex: 1,
    minWidth: 0,
  },
  tabs: {
    flexDirection: "row",
    gap: floraSpacing.gridFine,
    paddingHorizontal: floraSpacing.gridFine,
    paddingTop: floraSpacing.gridFine,
    paddingBottom: floraSpacing.gridFine,
  },
  tab: {
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.gridFine,
    borderRadius: 8,
  },
  tabActive: {
    backgroundColor: FLORA_THEME_TOKENS.reservePopoverAccentChip,
  },
  tabPressed: {
    opacity: 0.72,
  },
  tabText: {
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.39,
  },
  tabTextActive: {
    color: floraColors.greenLight,
  },
  grid: {
    flex: 1,
  },
  gridContent: {
    paddingHorizontal: floraSpacing.gridFine,
    paddingBottom: floraSpacing.gridFine,
  },
  sectionLead: {
    height: floraSpacing.gridFine,
  },
  sectionDivider: {
    paddingVertical: floraSpacing.gridFine,
  },
  sectionLine: {
    height: 1,
    backgroundColor: floraMessages.divider,
  },
  emojiRow: {
    flexDirection: "row",
    gap: MOBILE_EMOJI_CELL_GAP,
    marginBottom: MOBILE_EMOJI_CELL_GAP,
  },
  emojiCell: {
    width: MOBILE_EMOJI_CELL_SIZE,
    height: MOBILE_EMOJI_CELL_SIZE,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 6,
  },
  emojiCellSpacer: {
    width: MOBILE_EMOJI_CELL_SIZE,
    height: MOBILE_EMOJI_CELL_SIZE,
  },
  emojiCellPressed: {
    backgroundColor: "rgba(250, 250, 250, 0.08)",
  },
  emojiText: {
    fontSize: 22,
    lineHeight: 26,
  },
  stickersPlaceholder: {
    flex: 1,
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.grid,
    justifyContent: "center",
    gap: floraSpacing.grid,
  },
  stickersText: {
    color: floraColors.gray,
    fontSize: 14,
    fontWeight: "300",
    lineHeight: 20,
    letterSpacing: 0.42,
  },
  stickersLinkWrap: {
    alignSelf: "flex-start",
  },
  stickersLink: {
    color: floraColors.greenLight,
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.42,
  },
});

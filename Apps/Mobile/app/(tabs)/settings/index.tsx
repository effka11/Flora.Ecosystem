import { useLocalSearchParams } from "expo-router";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from "react-native";
import {
  Gesture,
  GestureDetector,
  Pressable as GesturePressable,
  ScrollView as GestureScrollView,
} from "react-native-gesture-handler";
import { LinearGradient } from "expo-linear-gradient";
import Reanimated, {
  cancelAnimation,
  Extrapolation,
  interpolate,
  runOnJS,
  runOnUI,
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AccountSettingsTab } from "@/components/settings/AccountSettingsTab";
import { CustomizationSettingsTab } from "@/components/settings/CustomizationSettingsTab";
import { FeedSettingsTab } from "@/components/settings/FeedSettingsTab";
import { NotificationsSettingsTab } from "@/components/settings/NotificationsSettingsTab";
import { PrivacySettingsTab } from "@/components/settings/PrivacySettingsTab";
import { SecuritySettingsTab } from "@/components/settings/SecuritySettingsTab";
import {
  SettingsConfirmModal,
  type SettingsConfirmKind,
} from "@/components/settings/SettingsConfirmModal";
import { UpdatesSettingsTab } from "@/components/settings/UpdatesSettingsTab";
import { TabScreenSearchHeader } from "@/components/TabScreenSearchHeader";
import {
  ENERGETIC_OPEN_EASING,
  ENERGETIC_OPEN_MS,
  settleEnergetic,
  snapPagerOffset,
} from "@/lib/energeticSettle";
import {
  schedulePagerMediaWake,
  type PagerMediaWakeHandle,
} from "@/lib/feedPagerMediaWake";
import {
  mountedSetsEqual,
  nextMountCandidate,
  reconcileMountedIds,
} from "@/lib/settingsMountedSections";
import { floraColors, floraSpacing, floraTabBarContentPadding, floraTabFilter } from "@/lib/theme";
import { useSessionStore } from "@/stores/sessionStore";
import { useSettingsDraftStore } from "@/stores/settingsDraftStore";

/** Как feed / messages pager — не перехватывать вертикальный скролл. */
const PAGER_AXIS_PX = 10;
/** Чипы: выше порог, чем pager — тап не уезжает в pan. */
const CHIP_PAN_AXIS_PX = 24;
/** Ниже — без withDecay (короткий жест/тап не запускает инерцию). */
const CHIP_DECAY_MIN_VX = 320;
/** Chip strip: follow pager vs free pan + decay. */
const STRIP_MODE_FOLLOW = 0;
const STRIP_MODE_FREE = 1;
const TABS_PAD_X = floraSpacing.grid;
/**
 * База ширины индикатора: реальная ширина — через scaleX (transform), а не
 * width. Анимация width — layout-свойство: commit shadow-дерева + Yoga на
 * каждом кадре свайпа. При высоте 2px деформация скруглений не различима.
 */
const TAB_INDICATOR_BASE_W = 120;
/** Прогрев дальней секции — только после такой паузы во взаимодействии. */
const WARMUP_QUIET_MS = 400;
/** Зазор между шагами прогрева: маунт и его async-догрузки успевают осесть. */
const WARMUP_STEP_GAP_MS = 120;

type TabLayout = { x: number; width: number };

/** Как лента: диапазоны в JS; на UI-потоке только interpolate(scrollX). Полоса чипов тоже от scrollX. */
type TabsChromeMotion = {
  ready: boolean;
  inputRange: number[];
  stripOffset: number[];
  indicatorX: number[];
  indicatorW: number[];
  maxStripOffset: number;
};

function buildTabsChromeMotion(
  sections: readonly SettingsSection[],
  layouts: Partial<Record<SettingsSectionId, TabLayout>>,
  pageWidth: number,
  viewportW: number,
  contentW: number,
): TabsChromeMotion {
  const empty: TabsChromeMotion = {
    ready: false,
    inputRange: [0, 1],
    stripOffset: [0, 0],
    indicatorX: [0, 0],
    indicatorW: [0, 0],
    maxStripOffset: 0,
  };
  const count = sections.length;
  if (count < 1 || pageWidth <= 0 || viewportW <= 0) return empty;
  for (let i = 0; i < count; i++) {
    if (!layouts[sections[i].id]) return empty;
  }

  const maxStripOffset = Math.max(0, contentW - viewportW);
  const inputRange: number[] = [];
  const stripOffset: number[] = [];
  const indicatorX: number[] = [];
  const indicatorW: number[] = [];

  for (let i = 0; i < count; i++) {
    const layout = layouts[sections[i].id]!;
    inputRange.push(i * pageWidth);
    indicatorX.push(layout.x);
    indicatorW.push(layout.width);
    const focus = TABS_PAD_X + layout.x + layout.width / 2;
    const offset =
      maxStripOffset <= 0 ? 0 : Math.max(0, Math.min(maxStripOffset, focus - viewportW / 2));
    stripOffset.push(offset);
  }

  if (inputRange.length === 1) {
    inputRange.push(inputRange[0] + pageWidth);
    stripOffset.push(stripOffset[0]);
    indicatorX.push(indicatorX[0]);
    indicatorW.push(indicatorW[0]);
  }

  return {
    ready: true,
    inputRange,
    stripOffset,
    indicatorX,
    indicatorW,
    maxStripOffset,
  };
}

const SettingsSectionTabLabel = memo(function SettingsSectionTabLabel({
  index,
  label,
  scrollX,
  pageWidth,
  pageCount,
}: {
  index: number;
  label: string;
  scrollX: SharedValue<number>;
  pageWidth: number;
  pageCount: number;
}) {
  /**
   * Кроссфейд серый↔зелёный — двумя слоями текста через opacity. Анимация
   * color текста на Fabric — это UPDATE_STATE-коммит Paragraph (клон
   * shadow-узла + перемер текста) на каждое touch-событие свайпа: в трейсе
   * это ~8–10 мс UI-потока на MOVE при бюджете кадра 8.3 мс (120 Гц).
   * Opacity применяется в view напрямую без коммита; green-over-gray с
   * альфой a = a·green + (1−a)·gray — та же линейная интерполяция цвета.
   */
  const overlayStyle = useAnimatedStyle(() => {
    if (pageWidth <= 0 || pageCount <= 0) return { opacity: 0 };
    if (pageCount === 1) return { opacity: 1 };
    const distance = Math.abs(scrollX.value / pageWidth - index);
    return { opacity: distance >= 1 ? 0 : 1 - distance };
  });

  return (
    <View>
      <Text style={styles.tabLabel}>{label}</Text>
      <Reanimated.Text
        pointerEvents="none"
        style={[styles.tabLabel, styles.tabLabelActive, overlayStyle]}
      >
        {label}
      </Reanimated.Text>
    </View>
  );
});

type SettingsSectionId =
  | "account"
  | "privacy"
  | "security"
  | "notifications"
  | "updates"
  | "feed"
  | "customization";

type SettingsSection = {
  id: SettingsSectionId;
  label: string;
  description: string;
  keywords: readonly string[];
};

/** Ширина фейда по краям горизонтальных подвкладок. */
const SECTION_TABS_EDGE_FADE = floraSpacing.grid;
const SECTION_TABS_FADE_SOLID = floraColors.bg;
const SECTION_TABS_FADE_CLEAR = "rgba(12, 12, 12, 0)";

const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "account",
    label: "Аккаунт",
    description: "Имя, никнейм, почта и параметры профиля.",
    keywords: [
      "имя",
      "ник",
      "никнейм",
      "аватар",
      "фото",
      "статус",
      "описание",
      "профиль",
      "выйти",
      "сохранить",
      "дата",
      "рождение",
      "сессия",
    ],
  },
  {
    id: "privacy",
    label: "Приватность",
    description: "Кто видит профиль, статус и переписки.",
    keywords: [
      "блок",
      "блокировка",
      "чёрный список",
      "черный список",
      "блоклист",
      "приватность",
      "видимость",
      "онлайн",
      "друзья",
      "комментарии",
      "сообщения",
    ],
  },
  {
    id: "security",
    label: "Безопасность",
    description: "Пароль, сессии и двухфакторная аутентификация.",
    keywords: ["ключ", "e2e", "fscp", "backup", "пароль", "безопасность", "синхронизация"],
  },
  {
    id: "notifications",
    label: "Уведомления",
    description: "Push и оповещения в приложении.",
    keywords: [
      "push",
      "сообщения",
      "уведомления",
      "текст",
      "превью",
      "email",
      "почта",
      "тихий",
      "тишина",
      "матрица",
      "события",
    ],
  },
  {
    id: "updates",
    label: "Обновления",
    description: "Версия приложения, установка APK и фоновое обновление.",
    keywords: [
      "обновление",
      "apk",
      "версия",
      "установка",
      "фон",
      "фоновое",
      "канал",
      "проверить",
    ],
  },
  {
    id: "feed",
    label: "Лента",
    description: "Рекомендации, свежесть и скрытые авторы.",
    keywords: [
      "лента",
      "рекомендации",
      "свежесть",
      "репосты",
      "сообщества",
      "скрытые",
      "интересно",
      "авторы",
      "просмотренные",
    ],
  },
  {
    id: "customization",
    label: "Кастомизация",
    description: "Тема, язык и оформление интерфейса.",
    keywords: ["тема", "язык", "оформление", "кастомизация", "акцент", "шрифт"],
  },
] as const;

function parseSectionId(value: string | string[] | undefined): SettingsSectionId {
  const raw = Array.isArray(value) ? value[0] : value;
  return SETTINGS_SECTIONS.some((section) => section.id === raw) ? (raw as SettingsSectionId) : "account";
}

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase();
}

function matchesSearch(query: string, ...haystacks: readonly (string | null | undefined)[]): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  return haystacks.some((item) => (item ?? "").toLowerCase().includes(q));
}

function sectionMatchesSearch(section: SettingsSection, query: string): boolean {
  return matchesSearch(query, section.label, section.description, ...section.keywords);
}

function contentSearchQueryForSection(section: SettingsSection, search: string): string {
  const hasSearch = normalizeSearch(search).length > 0;
  if (hasSearch && matchesSearch(search, section.label, section.description)) return "";
  return search;
}

/** memo: flip isActive у страницы не должен пере-рендерить всю форму (тяжёлые вкладки). */
const SettingsTabContent = memo(function SettingsTabContent({
  activeSection,
  searchQuery,
}: {
  activeSection: SettingsSectionId;
  searchQuery: string;
}) {
  switch (activeSection) {
    case "privacy":
      return <PrivacySettingsTab searchQuery={searchQuery} />;
    case "security":
      return <SecuritySettingsTab searchQuery={searchQuery} />;
    case "notifications":
      return <NotificationsSettingsTab searchQuery={searchQuery} />;
    case "updates":
      return <UpdatesSettingsTab searchQuery={searchQuery} />;
    case "feed":
      return <FeedSettingsTab searchQuery={searchQuery} />;
    case "customization":
      return <CustomizationSettingsTab searchQuery={searchQuery} />;
    case "account":
    default:
      return <AccountSettingsTab searchQuery={searchQuery} />;
  }
});

/** Контент sticky-mount; mid-pan setState запрещён — окно расширяет wake после settle. */
const SettingsSectionPage = memo(function SettingsSectionPage({
  section,
  search,
  pageWidth,
  listPaddingBottom,
  isActive,
}: {
  section: SettingsSection;
  search: string;
  pageWidth: number;
  listPaddingBottom: number;
  isActive: boolean;
}) {
  return (
    <View style={[styles.page, { width: pageWidth }]} collapsable={false}>
      {/* RNGH ScrollView, как скролл ленты: при активации pager-pan RNGH
          отменяет скролл детерминированно на UI-потоке — обычный RN ScrollView
          конкурирует за touch через Android-перехват и дёргает горизонтальный
          свайп. overScroll «never» на неактивных: EdgeEffect не должен жить
          на страницах, которые едут в translateX (как в ленте). */}
      <GestureScrollView
        style={styles.content}
        contentContainerStyle={[styles.contentInner, { paddingBottom: listPaddingBottom }]}
        keyboardShouldPersistTaps="handled"
        scrollEnabled={isActive}
        overScrollMode={isActive ? "auto" : "never"}
        showsVerticalScrollIndicator={false}
        removeClippedSubviews
      >
        <SettingsTabContent
          activeSection={section.id}
          searchQuery={contentSearchQueryForSection(section, search)}
        />
      </GestureScrollView>
    </View>
  );
});

export default function SettingsScreen() {
  const insets = useSafeAreaInsets();
  const { width: pageWidth } = useWindowDimensions();
  const listPaddingBottom = floraTabBarContentPadding(Math.max(insets.bottom, 8));
  const params = useLocalSearchParams<{ section?: string }>();
  const initialSection = useMemo(() => parseSectionId(params.section), [params.section]);
  const me = useSessionStore((s) => s.me);
  const syncSettingsFromMe = useSettingsDraftStore((s) => s.syncFromMe);
  const loadPrivacySettings = useSettingsDraftStore((s) => s.loadPrivacy);
  const loadFeedSettings = useSettingsDraftStore((s) => s.loadFeed);
  const settingsDirty = useSettingsDraftStore((s) => s.dirty);
  const settingsSaving = useSettingsDraftStore((s) => s.saving);
  const settingsSaveError = useSettingsDraftStore((s) => s.saveError);
  const saveAllSettings = useSettingsDraftStore((s) => s.saveAll);
  const discardSettingsChanges = useSettingsDraftStore((s) => s.discardChanges);
  const clearSettingsSaveFeedback = useSettingsDraftStore((s) => s.clearSaveFeedback);
  const [confirmKind, setConfirmKind] = useState<SettingsConfirmKind | null>(null);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(initialSection);
  const [mountedSectionIds, setMountedSectionIds] = useState<ReadonlySet<SettingsSectionId>>(
    () => new Set([initialSection]),
  );
  /** Поиск в шапке отключён — слот под discard/save. */
  const search = "";

  useEffect(() => {
    syncSettingsFromMe(me);
  }, [me, syncSettingsFromMe]);

  useEffect(() => {
    void loadPrivacySettings();
  }, [loadPrivacySettings]);

  useEffect(() => {
    void loadFeedSettings();
  }, [loadFeedSettings]);

  const onRequestSaveSettings = useCallback(() => {
    if (!settingsDirty || settingsSaving) return;
    clearSettingsSaveFeedback();
    setConfirmKind("save");
  }, [clearSettingsSaveFeedback, settingsDirty, settingsSaving]);

  const onRequestDiscardSettings = useCallback(() => {
    if (!settingsDirty || settingsSaving) return;
    clearSettingsSaveFeedback();
    setConfirmKind("discard");
  }, [clearSettingsSaveFeedback, settingsDirty, settingsSaving]);

  const onDismissConfirm = useCallback(() => {
    if (settingsSaving) return;
    setConfirmKind(null);
    clearSettingsSaveFeedback();
  }, [clearSettingsSaveFeedback, settingsSaving]);

  const onConfirmSettingsAction = useCallback(() => {
    if (confirmKind === "discard") {
      discardSettingsChanges();
      setConfirmKind(null);
      return;
    }
    if (confirmKind !== "save") return;
    void saveAllSettings().then((result) => {
      if (result.ok) setConfirmKind(null);
    });
  }, [confirmKind, discardSettingsChanges, saveAllSettings]);
  const [tabLayouts, setTabLayouts] = useState<Partial<Record<SettingsSectionId, TabLayout>>>({});
  const [tabsViewportW, setTabsViewportW] = useState(0);
  const [tabsContentW, setTabsContentW] = useState(0);
  const pagerTargetRef = useRef<SettingsSectionId>(initialSection);
  const visibleSectionsRef = useRef<readonly SettingsSection[]>(SETTINGS_SECTIONS);
  const visibleIdsRef = useRef<readonly SettingsSectionId[]>(
    SETTINGS_SECTIONS.map((section) => section.id),
  );
  const mountWakeRef = useRef<PagerMediaWakeHandle | null>(null);
  const mountedIdsRef = useRef(mountedSectionIds);
  /**
   * Fabric-mount тяжёлой вкладки идёт на Android main thread и роняет кадры
   * pan/decay/settle. Пока экраном владеет касание или анимация — расширение
   * окна откладывается в pending и монтируется на первом idle. Владельцы
   * раздельные: одновременные «палец на полосе + settle pager'а» не должны
   * снимать busy друг у друга.
   */
  const touchCountRef = useRef(0);
  const pagerMotionRef = useRef(false);
  const stripMotionRef = useRef(false);
  const pendingExpandIndexRef = useRef<number | null>(null);
  /**
   * Прогрев дальних секций — только после паузы во взаимодействии: маунт,
   * начавшийся за миг до касания, дёргает первые кадры свайпа (busy-guard
   * ловит wake во время жеста, но не маунт, стартовавший до него).
   */
  const lastInteractionAtRef = useRef(Date.now());
  const warmupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  mountedIdsRef.current = mountedSectionIds;

  const scrollX = useSharedValue(0);
  const dragStartX = useSharedValue(0);
  const pageWidthSV = useSharedValue(pageWidth);
  const pageCountSV = useSharedValue(SETTINGS_SECTIONS.length);
  const stripOffsetSV = useSharedValue(0);
  const stripDragStartSV = useSharedValue(0);
  const maxStripOffsetSV = useSharedValue(0);
  const stripModeSV = useSharedValue(STRIP_MODE_FOLLOW);
  /** Bit0 strip settle done, bit1 pager settle done — follow только когда оба. */
  const stripHandoffSV = useSharedValue(0);
  const inputRangeSV = useSharedValue<number[]>([0, 1]);
  const typicalOffsetsSV = useSharedValue<number[]>([0, 0]);

  const hasSearch = normalizeSearch(search).length > 0;
  const visibleSections = useMemo(() => {
    if (!hasSearch) return SETTINGS_SECTIONS;
    return SETTINGS_SECTIONS.filter((section) => sectionMatchesSearch(section, search));
  }, [hasSearch, search]);

  const visibleIds = useMemo(
    () => visibleSections.map((section) => section.id),
    [visibleSections],
  );

  visibleSectionsRef.current = visibleSections;
  visibleIdsRef.current = visibleIds;

  const tabsChrome = useMemo(
    () => buildTabsChromeMotion(visibleSections, tabLayouts, pageWidth, tabsViewportW, tabsContentW),
    [pageWidth, tabLayouts, tabsContentW, tabsViewportW, visibleSections],
  );

  const recordTabLayout = useCallback((id: SettingsSectionId, event: LayoutChangeEvent) => {
    const { x, width } = event.nativeEvent.layout;
    setTabLayouts((prev) => {
      const existing = prev[id];
      if (existing?.x === x && existing?.width === width) return prev;
      return { ...prev, [id]: { x, width } };
    });
  }, []);

  const cancelMountWake = useCallback(() => {
    mountWakeRef.current?.cancel();
    mountWakeRef.current = null;
    if (warmupTimerRef.current != null) {
      clearTimeout(warmupTimerRef.current);
      warmupTimerRef.current = null;
    }
  }, []);

  const isInteractionBusy = useCallback(
    () => touchCountRef.current > 0 || pagerMotionRef.current || stripMotionRef.current,
    [],
  );

  /** Рекурсия цепочки прогрева — через ref (self-reference в useCallback). */
  const scheduleMountAdvanceRef = useRef<(activeIndex: number) => void>(() => {});

  /**
   * Один idle-шаг окна маунта: сперва active±1 (как раньше), затем прогрев
   * остальных секций по одной за шаг. После прогрева свайп не вызывает
   * mount/commit вообще — как в ленте, где обе панели всегда смонтированы.
   */
  const scheduleMountAdvance = useCallback(
    (activeIndex: number) => {
      cancelMountWake();
      pendingExpandIndexRef.current = null;
      mountWakeRef.current = schedulePagerMediaWake({
        run: () => {
          mountWakeRef.current = null;
          if (isInteractionBusy()) {
            // InteractionManager не видит RNGH/Reanimated — сами ждём конца жеста.
            pendingExpandIndexRef.current = activeIndex;
            return;
          }
          const withNeighbors = reconcileMountedIds({
            prev: mountedIdsRef.current,
            visibleIds: visibleIdsRef.current,
            activeIndex,
            expandNeighbors: true,
          });
          if (!mountedSetsEqual(mountedIdsRef.current, withNeighbors)) {
            // Ref обновляем сразу: следующий шаг цепочки не должен читать устаревший set.
            mountedIdsRef.current = withNeighbors;
            setMountedSectionIds((prev) => {
              const next = reconcileMountedIds({
                prev,
                visibleIds: visibleIdsRef.current,
                activeIndex,
                expandNeighbors: true,
              });
              return mountedSetsEqual(prev, next) ? prev : next;
            });
            scheduleMountAdvanceRef.current(activeIndex);
            return;
          }
          const candidate = nextMountCandidate(
            visibleIdsRef.current,
            mountedIdsRef.current,
            activeIndex,
          );
          if (candidate == null) return;
          // Дальняя секция не нужна следующему свайпу — греем только в тишину,
          // иначе маунт ляжет между быстрыми жестами и дёрнет старт свайпа.
          const quietFor = Date.now() - lastInteractionAtRef.current;
          if (quietFor < WARMUP_QUIET_MS) {
            warmupTimerRef.current = setTimeout(() => {
              warmupTimerRef.current = null;
              scheduleMountAdvanceRef.current(activeIndex);
            }, WARMUP_QUIET_MS - quietFor);
            return;
          }
          const grown = new Set(mountedIdsRef.current);
          grown.add(candidate);
          mountedIdsRef.current = grown;
          setMountedSectionIds((prev) => {
            if (prev.has(candidate)) return prev;
            const next = new Set(prev);
            next.add(candidate);
            return next;
          });
          warmupTimerRef.current = setTimeout(() => {
            warmupTimerRef.current = null;
            scheduleMountAdvanceRef.current(activeIndex);
          }, WARMUP_STEP_GAP_MS);
        },
      });
    },
    [cancelMountWake, isInteractionBusy],
  );

  scheduleMountAdvanceRef.current = scheduleMountAdvance;

  /** Владелец отпустил экран — перепланировать отложенный mount на idle. */
  const flushExpandIfIdle = useCallback(() => {
    if (isInteractionBusy()) return;
    const pending = pendingExpandIndexRef.current;
    if (pending == null) return;
    scheduleMountAdvance(pending);
  }, [isInteractionBusy, scheduleMountAdvance]);

  const onTouchBegin = useCallback(() => {
    lastInteractionAtRef.current = Date.now();
    touchCountRef.current += 1;
  }, []);

  /** Тач полосы дополнительно снимает владение с отменённого decay. */
  const onStripTouchBegin = useCallback(() => {
    lastInteractionAtRef.current = Date.now();
    touchCountRef.current += 1;
    stripMotionRef.current = false;
  }, []);

  const onTouchFinalize = useCallback(() => {
    lastInteractionAtRef.current = Date.now();
    touchCountRef.current = Math.max(0, touchCountRef.current - 1);
    flushExpandIfIdle();
  }, [flushExpandIfIdle]);

  const setPagerMotion = useCallback(
    (active: boolean) => {
      lastInteractionAtRef.current = Date.now();
      pagerMotionRef.current = active;
      if (!active) flushExpandIfIdle();
    },
    [flushExpandIfIdle],
  );

  const setStripMotion = useCallback(
    (active: boolean) => {
      lastInteractionAtRef.current = Date.now();
      stripMotionRef.current = active;
      if (!active) flushExpandIfIdle();
    },
    [flushExpandIfIdle],
  );

  const commitPagerIndex = useCallback(
    (index: number) => {
      const next = visibleSectionsRef.current[index];
      if (!next) return;
      pagerTargetRef.current = next.id;
      // Settle доехал; свежая экспансия ниже заменяет pending (палец мог
      // уже владеть экраном — wake сам отложится через isInteractionBusy).
      lastInteractionAtRef.current = Date.now();
      pagerMotionRef.current = false;
      setActiveSection((current) => (current === next.id ? current : next.id));
      scheduleMountAdvance(index);
    },
    [scheduleMountAdvance],
  );

  const switchSection = useCallback(
    (next: SettingsSectionId) => {
      const index = visibleSectionsRef.current.findIndex((section) => section.id === next);
      if (index < 0) return;
      if (next === pagerTargetRef.current && Math.abs(scrollX.value - index * pageWidth) < 1) {
        return;
      }
      // Tap не pan: целевую секцию монтируем сразу; active/соседи — после settle+wake.
      pagerTargetRef.current = next;
      // Оба settle (полоса + pager) под одним владельцем; commit снимет.
      pagerMotionRef.current = true;
      const needsMount = !mountedIdsRef.current.has(next);
      if (needsMount) {
        setMountedSectionIds((prev) => {
          if (prev.has(next)) return prev;
          const nextSet = new Set(prev);
          nextSet.add(next);
          return nextSet;
        });
      }
      const target = index * pageWidth;
      const settleWorklet = () => {
        "worklet";
        stripModeSV.value = STRIP_MODE_FREE;
        stripHandoffSV.value = 0;
        cancelAnimation(stripOffsetSV);
        cancelAnimation(scrollX);
        const typicals = typicalOffsetsSV.value;
        const typical =
          index >= 0 && index < typicals.length ? typicals[index]! : stripOffsetSV.value;
        const maxStrip = Math.max(maxStripOffsetSV.value, 1);
        const tryHandoff = () => {
          "worklet";
          if (stripHandoffSV.value === 3) {
            stripModeSV.value = STRIP_MODE_FOLLOW;
            stripHandoffSV.value = 0;
          }
        };
        settleEnergetic(
          stripOffsetSV,
          typical,
          maxStrip,
          1,
          0,
          ENERGETIC_OPEN_MS,
          ENERGETIC_OPEN_EASING,
          (finished) => {
            if (!finished) {
              stripModeSV.value = STRIP_MODE_FOLLOW;
              stripHandoffSV.value = 0;
              return;
            }
            stripHandoffSV.value |= 1;
            tryHandoff();
          },
        );
        const width = pageWidthSV.value;
        settleEnergetic(
          scrollX,
          target,
          width > 0 ? width : 1,
          1,
          0,
          ENERGETIC_OPEN_MS,
          ENERGETIC_OPEN_EASING,
          (finished) => {
            if (!finished) {
              stripModeSV.value = STRIP_MODE_FOLLOW;
              stripHandoffSV.value = 0;
              return;
            }
            stripHandoffSV.value |= 2;
            tryHandoff();
            runOnJS(commitPagerIndex)(index);
          },
        );
      };
      // Свежий mount: settle со следующего кадра, чтобы Fabric-mount формы
      // не съедал первые кадры анимации на Android main thread.
      if (needsMount) {
        requestAnimationFrame(() => {
          // Перебит более новым тапом — цель уже другая.
          if (pagerTargetRef.current !== next) return;
          runOnUI(settleWorklet)();
        });
      } else {
        runOnUI(settleWorklet)();
      }
    },
    [
      commitPagerIndex,
      maxStripOffsetSV,
      pageWidth,
      pageWidthSV,
      scrollX,
      stripHandoffSV,
      stripModeSV,
      stripOffsetSV,
      typicalOffsetsSV,
    ],
  );

  useEffect(() => {
    pagerTargetRef.current = initialSection;
    setActiveSection(initialSection);
    setMountedSectionIds(new Set([initialSection]));
    const index = Math.max(
      0,
      visibleIdsRef.current.findIndex((id) => id === initialSection),
    );
    scheduleMountAdvance(index);
  }, [initialSection, scheduleMountAdvance]);

  useEffect(() => {
    if (visibleSections.length === 0) return;
    if (!visibleSections.some((section) => section.id === activeSection)) {
      const fallback = visibleSections[0].id;
      pagerTargetRef.current = fallback;
      setActiveSection(fallback);
    }
  }, [activeSection, visibleSections]);

  useEffect(() => {
    pageWidthSV.value = pageWidth;
    pageCountSV.value = visibleSections.length;
    const index = Math.max(
      0,
      visibleSections.findIndex((section) => section.id === pagerTargetRef.current),
    );
    cancelAnimation(scrollX);
    scrollX.value = index * pageWidth;
  }, [pageCountSV, pageWidth, pageWidthSV, scrollX, visibleSections]);

  // Поиск/фильтр: sync без соседей, затем wake ±1 (не mid-pan).
  useEffect(() => {
    if (visibleIds.length === 0) {
      cancelMountWake();
      setMountedSectionIds(new Set());
      return;
    }
    const index = Math.max(
      0,
      visibleIds.findIndex((id) => id === pagerTargetRef.current),
    );
    setMountedSectionIds((prev) => {
      const next = reconcileMountedIds({
        prev,
        visibleIds,
        activeIndex: index,
        expandNeighbors: false,
      });
      return mountedSetsEqual(prev, next) ? prev : next;
    });
    scheduleMountAdvance(index);
  }, [cancelMountWake, scheduleMountAdvance, visibleIds]);

  useEffect(() => () => cancelMountWake(), [cancelMountWake]);

  // Синк typical/inputRange/max в UI-thread SV. Не трогаем stripOffsetSV —
  // запись с JS отменяет withTiming/withDecay и ломает follow.
  useEffect(() => {
    if (!tabsChrome.ready) return;
    inputRangeSV.value = tabsChrome.inputRange;
    typicalOffsetsSV.value = tabsChrome.stripOffset;
    maxStripOffsetSV.value = tabsChrome.maxStripOffset;
  }, [
    inputRangeSV,
    maxStripOffsetSV,
    tabsChrome.inputRange,
    tabsChrome.maxStripOffset,
    tabsChrome.ready,
    tabsChrome.stripOffset,
    typicalOffsetsSV,
  ]);

  const showEmpty = hasSearch && visibleSections.length === 0;

  /** follow: полоса = f(scrollX); free: полоса = stripOffsetSV (pan/decay/settle). */
  const tabsTrackStyle = useAnimatedStyle(() => {
    if (stripModeSV.value === STRIP_MODE_FOLLOW) {
      const input = inputRangeSV.value;
      const typical = typicalOffsetsSV.value;
      if (input.length >= 2 && typical.length === input.length) {
        const follow = interpolate(scrollX.value, input, typical, Extrapolation.CLAMP);
        return { transform: [{ translateX: -follow }] };
      }
    }
    return { transform: [{ translateX: -stripOffsetSV.value }] };
  });

  const tabsFadeLeftStyle = useAnimatedStyle(() => {
    let offset = stripOffsetSV.value;
    if (stripModeSV.value === STRIP_MODE_FOLLOW) {
      const input = inputRangeSV.value;
      const typical = typicalOffsetsSV.value;
      if (input.length >= 2 && typical.length === input.length) {
        offset = interpolate(scrollX.value, input, typical, Extrapolation.CLAMP);
      }
    }
    return { opacity: offset > 1 ? 1 : 0 };
  });

  const tabsFadeRightStyle = useAnimatedStyle(() => {
    let offset = stripOffsetSV.value;
    if (stripModeSV.value === STRIP_MODE_FOLLOW) {
      const input = inputRangeSV.value;
      const typical = typicalOffsetsSV.value;
      if (input.length >= 2 && typical.length === input.length) {
        offset = interpolate(scrollX.value, input, typical, Extrapolation.CLAMP);
      }
    }
    return {
      opacity: maxStripOffsetSV.value > 1 && offset < maxStripOffsetSV.value - 1 ? 1 : 0,
    };
  });

  // Только transform/opacity — ни одного layout-свойства на кадр свайпа.
  // scaleX вокруг центра: левый край = translateX + (BASE - w) / 2.
  const tabIndicatorStyle = useAnimatedStyle(() => {
    if (!tabsChrome.ready) {
      return { opacity: 0, transform: [{ translateX: 0 }, { scaleX: 0 }] };
    }
    const width = interpolate(
      scrollX.value,
      tabsChrome.inputRange,
      tabsChrome.indicatorW,
      Extrapolation.CLAMP,
    );
    const left = interpolate(
      scrollX.value,
      tabsChrome.inputRange,
      tabsChrome.indicatorX,
      Extrapolation.CLAMP,
    );
    return {
      opacity: 1,
      transform: [
        { translateX: left - (TAB_INDICATOR_BASE_W - width) / 2 },
        { scaleX: width / TAB_INDICATOR_BASE_W },
      ],
    };
  });

  const chipStripPan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-CHIP_PAN_AXIS_PX, CHIP_PAN_AXIS_PX])
        .failOffsetY([-CHIP_PAN_AXIS_PX, CHIP_PAN_AXIS_PX])
        .onBegin(() => {
          "worklet";
          // Снять инерцию в момент касания — иначе блокирует тап по чипу.
          cancelAnimation(stripOffsetSV);
          runOnJS(onStripTouchBegin)();
        })
        .onStart(() => {
          "worklet";
          // Зафиксировать текущий follow-offset в SV, затем free-pan.
          const input = inputRangeSV.value;
          const typical = typicalOffsetsSV.value;
          if (
            stripModeSV.value === STRIP_MODE_FOLLOW &&
            input.length >= 2 &&
            typical.length === input.length
          ) {
            stripOffsetSV.value = interpolate(
              scrollX.value,
              input,
              typical,
              Extrapolation.CLAMP,
            );
          }
          cancelAnimation(stripOffsetSV);
          stripModeSV.value = STRIP_MODE_FREE;
          stripDragStartSV.value = stripOffsetSV.value;
        })
        .onUpdate((event) => {
          "worklet";
          const max = Math.max(0, maxStripOffsetSV.value);
          const next = stripDragStartSV.value - event.translationX;
          stripOffsetSV.value = next < 0 ? 0 : next > max ? max : next;
        })
        .onEnd((event) => {
          "worklet";
          stripModeSV.value = STRIP_MODE_FREE;
          if (Math.abs(event.velocityX) < CHIP_DECAY_MIN_VX) {
            return;
          }
          runOnJS(setStripMotion)(true);
          stripOffsetSV.value = withDecay(
            {
              velocity: -event.velocityX,
              clamp: [0, Math.max(0, maxStripOffsetSV.value)],
            },
            (finished) => {
              // Отмену (finished=false) ведёт новый владелец (тач/пейджер).
              if (finished) runOnJS(setStripMotion)(false);
            },
          );
        })
        .onFinalize(() => {
          "worklet";
          runOnJS(onTouchFinalize)();
        }),
    [
      inputRangeSV,
      maxStripOffsetSV,
      onStripTouchBegin,
      onTouchFinalize,
      scrollX,
      setStripMotion,
      stripDragStartSV,
      stripModeSV,
      stripOffsetSV,
      typicalOffsetsSV,
    ],
  );

  const pagerPan = useMemo(
    () =>
      Gesture.Pan()
        .activeOffsetX([-PAGER_AXIS_PX, PAGER_AXIS_PX])
        .failOffsetY([-PAGER_AXIS_PX * 2, PAGER_AXIS_PX * 2])
        .onBegin(() => {
          "worklet";
          // С первого касания (до активации): pending-mount не должен упасть под палец.
          runOnJS(onTouchBegin)();
        })
        .onStart(() => {
          "worklet";
          cancelAnimation(scrollX);
          dragStartX.value = scrollX.value;
          if (stripModeSV.value === STRIP_MODE_FREE) {
            // Только стоп decay. Один settle полосы — на onEnd к typical[target],
            // иначе анимация к «старой» цели + прыжок в follow.
            cancelAnimation(stripOffsetSV);
            // Владение отменённым decay переходит этому жесту.
            runOnJS(setStripMotion)(false);
          } else {
            stripModeSV.value = STRIP_MODE_FOLLOW;
          }
        })
        .onUpdate((event) => {
          "worklet";
          const width = pageWidthSV.value;
          const count = pageCountSV.value;
          if (width <= 0 || count <= 0) return;
          const maxOffset = Math.max(0, count - 1) * width;
          scrollX.value = Math.max(0, Math.min(maxOffset, dragStartX.value - event.translationX));
        })
        .onEnd((event) => {
          "worklet";
          const width = pageWidthSV.value;
          const count = pageCountSV.value;
          if (width <= 0 || count <= 0) {
            runOnJS(setPagerMotion)(false);
            return;
          }
          // Settle стартует ниже; снимет commitPagerIndex.
          runOnJS(setPagerMotion)(true);
          const target = snapPagerOffset(scrollX.value, width, count, event.velocityX);
          const targetIndex = Math.round(target / width);
          const fromFree = stripModeSV.value === STRIP_MODE_FREE;

          const tryStripHandoff = () => {
            "worklet";
            // follow только когда полоса и pager доехали — иначе прыжок к f(scrollX).
            if (stripHandoffSV.value === 3) {
              stripModeSV.value = STRIP_MODE_FOLLOW;
              stripHandoffSV.value = 0;
            }
          };

          if (fromFree) {
            const typicals = typicalOffsetsSV.value;
            const stripTarget =
              targetIndex >= 0 && targetIndex < typicals.length
                ? typicals[targetIndex]!
                : stripOffsetSV.value;
            stripHandoffSV.value = 0;
            cancelAnimation(stripOffsetSV);
            settleEnergetic(
              stripOffsetSV,
              stripTarget,
              Math.max(maxStripOffsetSV.value, 1),
              1,
              0,
              ENERGETIC_OPEN_MS,
              ENERGETIC_OPEN_EASING,
              (finished) => {
                if (!finished) {
                  stripModeSV.value = STRIP_MODE_FOLLOW;
                  stripHandoffSV.value = 0;
                  return;
                }
                stripHandoffSV.value |= 1;
                tryStripHandoff();
              },
            );
            settleEnergetic(
              scrollX,
              target,
              width,
              1,
              event.velocityX,
              ENERGETIC_OPEN_MS,
              ENERGETIC_OPEN_EASING,
              (finished) => {
                if (!finished) {
                  stripModeSV.value = STRIP_MODE_FOLLOW;
                  stripHandoffSV.value = 0;
                  return;
                }
                stripHandoffSV.value |= 2;
                tryStripHandoff();
                runOnJS(commitPagerIndex)(targetIndex);
              },
            );
            return;
          }

          stripModeSV.value = STRIP_MODE_FOLLOW;
          settleEnergetic(
            scrollX,
            target,
            width,
            1,
            event.velocityX,
            ENERGETIC_OPEN_MS,
            ENERGETIC_OPEN_EASING,
            (finished) => {
              stripModeSV.value = STRIP_MODE_FOLLOW;
              if (finished) runOnJS(commitPagerIndex)(targetIndex);
            },
          );
        })
        .onFinalize(() => {
          "worklet";
          runOnJS(onTouchFinalize)();
        }),
    [
      commitPagerIndex,
      dragStartX,
      maxStripOffsetSV,
      onTouchBegin,
      onTouchFinalize,
      pageCountSV,
      pageWidthSV,
      scrollX,
      setPagerMotion,
      setStripMotion,
      stripHandoffSV,
      stripModeSV,
      stripOffsetSV,
      typicalOffsetsSV,
    ],
  );

  const pagerStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -scrollX.value }],
  }));

  return (
    <View style={styles.root}>
      <View style={[styles.topBlock, { paddingTop: insets.top + floraSpacing.grid }]}>
        <TabScreenSearchHeader
          title="Настройки"
          searchEnabled={false}
          discardAction={{
            accessibilityLabel: "Сбросить изменения",
            onPress: onRequestDiscardSettings,
            disabled: !settingsDirty || settingsSaving,
          }}
          saveAction={{
            accessibilityLabel: "Сохранить настройки",
            onPress: onRequestSaveSettings,
            disabled: !settingsDirty || settingsSaving,
            busy: settingsSaving,
          }}
        />
      </View>

      <SettingsConfirmModal
        visible={confirmKind !== null}
        kind={confirmKind}
        busy={confirmKind === "save" && settingsSaving}
        error={confirmKind === "save" ? settingsSaveError : null}
        onDismiss={onDismissConfirm}
        onConfirm={onConfirmSettingsAction}
      />

      {showEmpty ? (
        <View style={styles.content}>
          <Text style={styles.emptyHint}>Ничего не найдено. Измените запрос в поиске.</Text>
        </View>
      ) : (
        <View style={styles.pagerShell}>
          <View
            style={styles.tabsScrollWrap}
            onLayout={(event) => {
              const width = event.nativeEvent.layout.width;
              setTabsViewportW((prev) => (prev === width ? prev : width));
            }}
          >
            <GestureDetector gesture={chipStripPan}>
              <Reanimated.View
                style={[styles.tabsTrack, tabsTrackStyle]}
                onLayout={(event) => {
                  const width = event.nativeEvent.layout.width;
                  setTabsContentW((prev) => (prev === width ? prev : width));
                }}
              >
                <View style={styles.tabs}>
                  {tabsChrome.ready ? (
                    <Reanimated.View
                      pointerEvents="none"
                      style={[styles.tabIndicator, tabIndicatorStyle]}
                    />
                  ) : null}
                  {visibleSections.map((item, index) => {
                    const selected = item.id === activeSection;
                    return (
                      <GesturePressable
                        key={item.id}
                        accessibilityRole="tab"
                        accessibilityState={{ selected }}
                        style={({ pressed }) => [styles.tabButton, pressed && styles.tabPressed]}
                        onLayout={(event) => recordTabLayout(item.id, event)}
                        onPress={() => switchSection(item.id)}
                      >
                        <SettingsSectionTabLabel
                          index={index}
                          label={item.label}
                          scrollX={scrollX}
                          pageWidth={pageWidth}
                          pageCount={visibleSections.length}
                        />
                      </GesturePressable>
                    );
                  })}
                </View>
              </Reanimated.View>
            </GestureDetector>
            <Reanimated.View pointerEvents="none" style={[styles.tabsFadeLeft, tabsFadeLeftStyle]}>
              <LinearGradient
                colors={[SECTION_TABS_FADE_SOLID, SECTION_TABS_FADE_CLEAR]}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={StyleSheet.absoluteFill}
              />
            </Reanimated.View>
            <Reanimated.View pointerEvents="none" style={[styles.tabsFadeRight, tabsFadeRightStyle]}>
              <LinearGradient
                colors={[SECTION_TABS_FADE_CLEAR, SECTION_TABS_FADE_SOLID]}
                start={{ x: 0, y: 0.5 }}
                end={{ x: 1, y: 0.5 }}
                style={StyleSheet.absoluteFill}
              />
            </Reanimated.View>
          </View>

          <GestureDetector gesture={pagerPan}>
            <Reanimated.View style={styles.pagerBody}>
              {/* Без removeClippedSubviews: клиппинг Android не понимает translateX
                  и на каждом layout-кадре (width индикатора) детачит/аттачит целые
                  страницы mid-pan. pagerBody уже режет отрисовку overflow hidden. */}
              <Reanimated.View
                style={[
                  styles.pagerRow,
                  { width: Math.max(pageWidth, pageWidth * Math.max(visibleSections.length, 1)) },
                  pagerStyle,
                ]}
              >
                {visibleSections.map((item) =>
                  mountedSectionIds.has(item.id) ? (
                    <SettingsSectionPage
                      key={item.id}
                      section={item}
                      search={search}
                      pageWidth={pageWidth}
                      listPaddingBottom={listPaddingBottom}
                      isActive={item.id === activeSection}
                    />
                  ) : (
                    <View
                      key={item.id}
                      style={[styles.page, { width: pageWidth }]}
                      collapsable={false}
                    />
                  ),
                )}
              </Reanimated.View>
            </Reanimated.View>
          </GestureDetector>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: floraColors.bg,
  },
  topBlock: {
    backgroundColor: floraColors.bg,
    paddingHorizontal: floraSpacing.grid,
    paddingBottom: floraSpacing.gridFine,
    gap: 13,
  },
  pagerShell: {
    flex: 1,
  },
  tabsScrollWrap: {
    position: "relative",
    overflow: "hidden",
    borderBottomColor: "rgba(250, 250, 250, 0.08)",
    borderBottomWidth: 1,
    backgroundColor: floraColors.bg,
  },
  tabsTrack: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: TABS_PAD_X,
    alignSelf: "flex-start",
  },
  tabs: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    overflow: "visible",
  },
  tabsFadeLeft: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: SECTION_TABS_EDGE_FADE,
    zIndex: 3,
  },
  tabsFadeRight: {
    position: "absolute",
    right: 0,
    top: 0,
    bottom: 0,
    width: SECTION_TABS_EDGE_FADE,
    zIndex: 3,
  },
  tabButton: {
    height: floraTabFilter.triggerHeight,
    borderRadius: 999,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
  },
  tabPressed: {
    opacity: 0.72,
  },
  tabLabel: {
    color: floraColors.gray,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: floraTabFilter.triggerLabelLineHeight,
  },
  /** Зелёный слой кроссфейда поверх серого: одинаковая типографика, только цвет. */
  tabLabelActive: {
    position: "absolute",
    left: 0,
    top: 0,
    color: floraColors.greenLight,
  },
  tabIndicator: {
    position: "absolute",
    left: 0,
    bottom: 0,
    width: TAB_INDICATOR_BASE_W,
    height: floraTabFilter.indicatorHeight,
    borderRadius: 999,
    backgroundColor: floraColors.greenLight,
    zIndex: 2,
  },
  pagerBody: {
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
  },
  content: {
    flex: 1,
  },
  contentInner: {
    padding: floraSpacing.grid,
    gap: floraSpacing.grid,
  },
  emptyHint: {
    color: floraColors.gray,
    textAlign: "center",
    marginTop: floraSpacing.grid * 3,
    paddingHorizontal: floraSpacing.grid * 2,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 22,
  },
  pressed: {
    opacity: 0.72,
  },
});

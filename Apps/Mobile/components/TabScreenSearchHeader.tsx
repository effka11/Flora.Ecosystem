import { liveGridStyles } from "@/lib/liveGridStyles";
import { Ionicons } from "@expo/vector-icons";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ActivityIndicator,
  BackHandler,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Pressable as GesturePressable } from "react-native-gesture-handler";
import { KeyboardController } from "react-native-keyboard-controller";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useHamburgerMenu } from "@/components/HamburgerMenuProvider";
import { ChromeMoreIcon, ChromeSearchSavedCheck } from "@/components/chrome/ChromeIcons";
import {
  SEARCH_CHROME_EASING,
  SEARCH_CHROME_MS,
  useSearchChromeLayerStyles,
} from "@/components/chrome/searchChromeLayers";
import { floraColors, floraSpacing } from "@/lib/theme";
import { useReducedMotion } from "@/lib/useReducedMotion";

export type HeaderIconAction = {
  accessibilityLabel: string;
  onPress: () => void;
  /** Якорь для DropdownMenuOverlay (как меню «⋯» в compose). */
  anchorRef?: RefObject<View | null>;
};

export type HeaderSaveAction = {
  accessibilityLabel: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
};

export type TabScreenSearchHeaderProps = {
  title: string;
  /** Optional pill next to the title (e.g. build marker). */
  titleBadge?: string;
  placeholder?: string;
  value?: string;
  onChangeText?: (value: string) => void;
  /** Перед открытием меню (закрыть дропдауны фильтров и т.п.). */
  onBeforeMenuOpen?: () => void;
  /** Кнопка создания справа (правее поиска). */
  createAction?: HeaderIconAction;
  /** Сохранение (зелёная галочка). */
  saveAction?: HeaderSaveAction;
  /** Сброс изменений (крестик) в trailing; совместим с поиском. */
  discardAction?: HeaderSaveAction;
  /** По умолчанию true. false — без поля/кнопки поиска. */
  searchEnabled?: boolean;
  /**
   * Смена ключа (подвкладка / epoch жеста) → closeSearch, пока поиск смонтирован.
   * Первый рендер только запоминает значение.
   */
  dismissKey?: string | number;
  /** Поиск на экране (включая close-анимацию), без режима выделения. */
  onSearchActiveChange?: (active: boolean) => void;
  /** Тап по тегам под полем: не закрывать поиск из onBlur / keyboardDidHide. */
  holdSearchFocusRef?: MutableRefObject<(() => void) | null>;
  /**
   * Режим выделения списка (Messages): крестик / счётчик / ⋯ вместо
   * гамбургера / заголовка / «+». Поиск скрыт.
   */
  selectionChrome?: {
    selectedCount: number;
    onClose: () => void;
    moreAction?: HeaderIconAction;
  };
  /**
   * Ряд под шапкой (вкладки / теги). Рисуется и в режиме выделения.
   * `searchMounted` уже с учётом `!selectionChrome`.
   */
  below?: (chrome: {
    progress: SharedValue<number>;
    searchMounted: boolean;
  }) => ReactNode;
};

/** Запоздалый keyboardDidHide после оверлея фото — retry IME, не close. */
const SEARCH_IME_GRACE_MS = 400;
/** Нет didShow: blur→focus. */
const SEARCH_IME_WATCHDOG_MS = 300;

export function TabScreenSearchHeader({
  title,
  titleBadge,
  placeholder = "",
  value = "",
  onChangeText,
  onBeforeMenuOpen,
  createAction,
  saveAction,
  discardAction,
  searchEnabled = true,
  dismissKey,
  onSearchActiveChange,
  holdSearchFocusRef,
  selectionChrome,
  below,
}: TabScreenSearchHeaderProps) {
  const { openMenu, subscribeOpen } = useHamburgerMenu();
  const reduceMotion = useReducedMotion();
  const [searchOpen, setSearchOpen] = useState(false);
  /** Сессия поиска (включая close-анимацию) — теги / back, не маунт поля. */
  const [searchMounted, setSearchMounted] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const closingRef = useRef(false);
  /** Тап по тегу: не закрывать поиск, пока не истечёт окно. */
  const holdFocusUntilRef = useRef(0);
  /** Soft-keyboard уже показывалась для текущего сеанса поиска — иначе ignore didHide. */
  const keyboardSeenRef = useRef(false);
  /** Date.now() старта openSearch — окно против запоздалого hide. */
  const searchImeAtRef = useRef(0);
  /** Watchdog blur→focus: onBlur / didHide не закрывают поиск. */
  const imeForceRef = useRef(false);
  const searchOpenRef = useRef(false);
  searchOpenRef.current = searchOpen;
  const dismissKeyRef = useRef<string | number | undefined>(dismissKey);
  const dismissKeyReadyRef = useRef(false);
  const progress = useSharedValue(0);
  /** UI-поток: галочка у лупы гаснет в том же кадре, что clear, не ждёт React `value`. */
  const savedMarkOpacity = useSharedValue(1);
  const savedMarkStyle = useAnimatedStyle(() => ({ opacity: savedMarkOpacity.value }));

  const finishClose = useCallback(() => {
    closingRef.current = false;
    keyboardSeenRef.current = false;
    searchImeAtRef.current = 0;
    imeForceRef.current = false;
    setSearchOpen(false);
    setSearchMounted(false);
  }, []);

  const showSearchKeyboard = useCallback(() => {
    if (closingRef.current) return;
    const input = inputRef.current;
    if (!input) return;
    if (input.isFocused()) {
      KeyboardController.setFocusTo("current");
      return;
    }
    input.focus();
    requestAnimationFrame(() => {
      if (closingRef.current) return;
      if (inputRef.current?.isFocused()) {
        KeyboardController.setFocusTo("current");
      }
    });
  }, []);

  const isSearchImePending = useCallback(
    () => searchImeAtRef.current > 0 && Date.now() - searchImeAtRef.current < SEARCH_IME_GRACE_MS,
    [],
  );

  const abortClose = useCallback(() => {
    closingRef.current = false;
  }, []);

  const openSearch = useCallback(() => {
    if (closingRef.current) {
      cancelAnimation(progress);
      closingRef.current = false;
    }
    keyboardSeenRef.current = false;
    imeForceRef.current = false;
    searchImeAtRef.current = Date.now();
    setSearchOpen(true);
    setSearchMounted(true);
    showSearchKeyboard();
    if (reduceMotion) {
      progress.value = 1;
      return;
    }
    progress.value = withTiming(1, { duration: SEARCH_CHROME_MS, easing: SEARCH_CHROME_EASING });
  }, [progress, reduceMotion, showSearchKeyboard]);

  const closeSearch = useCallback(() => {
    if (closingRef.current) return;
    // До blur: иначе синхронный onBlur снова войдёт в closeSearch.
    closingRef.current = true;
    searchImeAtRef.current = 0;
    imeForceRef.current = false;
    holdFocusUntilRef.current = 0;
    inputRef.current?.blur();
    if (reduceMotion) {
      progress.value = 0;
      finishClose();
      return;
    }
    progress.value = withTiming(0, { duration: SEARCH_CHROME_MS, easing: SEARCH_CHROME_EASING }, (finished) => {
      if (finished) {
        runOnJS(finishClose)();
      } else {
        runOnJS(abortClose)();
      }
    });
  }, [abortClose, finishClose, progress, reduceMotion]);

  const holdSearchFocus = useCallback(() => {
    holdFocusUntilRef.current = Date.now() + 500;
  }, []);

  const clearSearchQuery = useCallback(() => {
    savedMarkOpacity.value = 0;
    searchImeAtRef.current = 0;
    imeForceRef.current = false;
    holdFocusUntilRef.current = 0;
    Keyboard.dismiss();
    inputRef.current?.blur();
    onChangeText?.("");
    if (reduceMotion) {
      cancelAnimation(progress);
      progress.value = 0;
      finishClose();
      return;
    }
    if (closingRef.current) return;
    closingRef.current = true;
    cancelAnimation(progress);
    progress.value = withTiming(0, { duration: SEARCH_CHROME_MS, easing: SEARCH_CHROME_EASING }, (finished) => {
      if (finished) {
        runOnJS(finishClose)();
      } else {
        runOnJS(abortClose)();
      }
    });
  }, [abortClose, finishClose, onChangeText, progress, reduceMotion, savedMarkOpacity]);

  const isSearchFocusHeld = useCallback(() => Date.now() < holdFocusUntilRef.current, []);

  const onSearchBlur = useCallback(() => {
    if (imeForceRef.current) return;
    if (selectionChrome || closingRef.current || !searchOpen) return;
    if (isSearchFocusHeld() || isSearchImePending()) {
      requestAnimationFrame(showSearchKeyboard);
      return;
    }
    closeSearch();
  }, [closeSearch, isSearchFocusHeld, isSearchImePending, searchOpen, selectionChrome, showSearchKeyboard]);

  useEffect(() => {
    if (!holdSearchFocusRef) return;
    holdSearchFocusRef.current = holdSearchFocus;
    return () => {
      if (holdSearchFocusRef.current === holdSearchFocus) {
        holdSearchFocusRef.current = null;
      }
    };
  }, [holdSearchFocus, holdSearchFocusRef]);

  useEffect(() => {
    if (searchEnabled) return;
    cancelAnimation(progress);
    closingRef.current = false;
    keyboardSeenRef.current = false;
    searchImeAtRef.current = 0;
    imeForceRef.current = false;
    progress.value = 0;
    setSearchOpen(false);
    setSearchMounted(false);
  }, [progress, searchEnabled]);

  const selectionActive = Boolean(selectionChrome);

  useEffect(() => {
    if (!selectionActive) return;
    cancelAnimation(progress);
    closingRef.current = false;
    keyboardSeenRef.current = false;
    searchImeAtRef.current = 0;
    imeForceRef.current = false;
    inputRef.current?.blur();
    progress.value = 0;
    setSearchOpen(false);
    setSearchMounted(false);
  }, [progress, selectionActive]);

  useEffect(() => {
    if (!dismissKeyReadyRef.current) {
      dismissKeyRef.current = dismissKey;
      dismissKeyReadyRef.current = true;
      return;
    }
    if (dismissKey === dismissKeyRef.current) return;
    dismissKeyRef.current = dismissKey;
    if (!searchEnabled || !searchMounted || selectionChrome) return;
    closeSearch();
  }, [closeSearch, dismissKey, searchEnabled, searchMounted, selectionChrome]);

  useEffect(() => {
    if (!searchEnabled || !searchOpen || selectionChrome) return;
    const watchdog = setTimeout(() => {
      if (closingRef.current || !searchOpenRef.current) return;
      if (keyboardSeenRef.current) return;
      const input = inputRef.current;
      if (!input?.isFocused()) {
        showSearchKeyboard();
        return;
      }
      imeForceRef.current = true;
      input.blur();
      requestAnimationFrame(() => {
        if (closingRef.current || !searchOpenRef.current) {
          imeForceRef.current = false;
          return;
        }
        showSearchKeyboard();
        imeForceRef.current = false;
      });
    }, SEARCH_IME_WATCHDOG_MS);
    return () => clearTimeout(watchdog);
  }, [searchEnabled, searchOpen, selectionChrome, showSearchKeyboard]);

  // Пока поиск на экране (включая close-анимацию). При selectionChrome back
  // ест listener выделения в messages/index.tsx — шапка не конкурирует.
  useEffect(() => {
    if (!searchEnabled || !searchMounted || selectionChrome) return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      closeSearch();
      return true;
    });
    return () => sub.remove();
  }, [closeSearch, searchEnabled, searchMounted, selectionChrome]);

  useEffect(() => {
    if (!searchEnabled || !searchMounted || selectionChrome) return;
    const showSub = Keyboard.addListener("keyboardDidShow", () => {
      keyboardSeenRef.current = true;
    });
    const hideSub = Keyboard.addListener("keyboardDidHide", () => {
      if (closingRef.current || imeForceRef.current) return;
      if (isSearchImePending() || isSearchFocusHeld()) {
        requestAnimationFrame(showSearchKeyboard);
        return;
      }
      if (!keyboardSeenRef.current) return;
      keyboardSeenRef.current = false;
      closeSearch();
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [closeSearch, isSearchFocusHeld, isSearchImePending, searchEnabled, searchMounted, selectionChrome, showSearchKeyboard]);

  useEffect(() => {
    if (!searchEnabled || !searchMounted || selectionChrome) return;
    return subscribeOpen(() => {
      closeSearch();
    });
  }, [closeSearch, searchEnabled, searchMounted, selectionChrome, subscribeOpen]);

  useEffect(() => {
    if (value.trim().length === 0) return;
    savedMarkOpacity.value = 1;
  }, [savedMarkOpacity, value]);

  const searchActive = searchEnabled && searchMounted && !selectionChrome;
  const visibleSearchMounted = searchMounted && !selectionChrome;
  const onSearchActiveChangeRef = useRef(onSearchActiveChange);
  onSearchActiveChangeRef.current = onSearchActiveChange;
  useEffect(() => {
    onSearchActiveChangeRef.current?.(searchActive);
  }, [searchActive]);

  const { searchStyle } = useSearchChromeLayerStyles(progress);

  const handleMenuPressIn = () => {
    onBeforeMenuOpen?.();
    openMenu();
  };

  const belowRow = below?.({ progress, searchMounted: visibleSearchMounted });
  const hasSavedQuery = value.trim().length > 0;
  const searchLayerActive = searchOpen && !selectionChrome;
  const more = selectionChrome?.moreAction;

  return (
    <>
      <View style={styles.chromeRow}>
        <View
          pointerEvents={searchMounted && !selectionChrome ? "none" : "auto"}
          style={styles.idleLayer}
        >
          {selectionChrome ? (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Отменить выбор"
                style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                onPress={selectionChrome.onClose}
              >
                <Ionicons name="close-outline" size={26} color={floraColors.gray} />
              </Pressable>

              <View style={styles.titleRow}>
                <Text style={styles.title} numberOfLines={1}>
                  {selectionChrome.selectedCount}
                </Text>
              </View>
              <View style={styles.spacer} />

              <View style={styles.trailingActions}>
                {more ? (
                  <View ref={more.anchorRef} collapsable={false}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={more.accessibilityLabel}
                      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                      onPress={more.onPress}
                    >
                      <ChromeMoreIcon color={floraColors.gray} />
                    </Pressable>
                  </View>
                ) : null}
              </View>
            </>
          ) : (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Меню"
                style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                onPressIn={handleMenuPressIn}
              >
                <Ionicons name="menu-outline" size={24} color={floraColors.gray} />
              </Pressable>

              <View style={styles.titleRow}>
                <Text style={styles.title} numberOfLines={1}>
                  {title}
                </Text>
                {titleBadge ? (
                  <View style={styles.titleBadge} accessibilityRole="text">
                    <Text style={styles.titleBadgeText} numberOfLines={1}>
                      {titleBadge}
                    </Text>
                  </View>
                ) : null}
              </View>
              <View style={styles.spacer} />

              <View style={styles.trailingActions}>
                {searchEnabled ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={hasSavedQuery ? "Поиск, запрос сохранён" : "Поиск"}
                    style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                    onPressIn={openSearch}
                  >
                    {hasSavedQuery ? (
                      <Animated.View pointerEvents="none" style={[styles.searchSavedMark, savedMarkStyle]}>
                        <ChromeSearchSavedCheck color={floraColors.greenLight} />
                      </Animated.View>
                    ) : null}
                    <Ionicons name="search-outline" size={22} color={floraColors.gray} />
                  </Pressable>
                ) : null}
                {discardAction ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={discardAction.accessibilityLabel}
                    disabled={discardAction.disabled || discardAction.busy}
                    style={({ pressed }) => [
                      styles.iconButton,
                      (discardAction.disabled || discardAction.busy) && styles.iconButtonDisabled,
                      pressed && !discardAction.disabled && !discardAction.busy && styles.pressed,
                    ]}
                    onPress={discardAction.onPress}
                  >
                    <Ionicons name="close-outline" size={28} color={floraColors.gray} />
                  </Pressable>
                ) : null}
                {saveAction ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={saveAction.accessibilityLabel}
                    disabled={saveAction.disabled || saveAction.busy}
                    style={({ pressed }) => [
                      styles.iconButton,
                      (saveAction.disabled || saveAction.busy) && styles.iconButtonDisabled,
                      pressed && !saveAction.disabled && !saveAction.busy && styles.pressed,
                    ]}
                    onPress={saveAction.onPress}
                  >
                    {saveAction.busy ? (
                      <ActivityIndicator size="small" color={floraColors.greenLight} />
                    ) : (
                      <Ionicons name="checkmark" size={26} color={floraColors.greenLight} />
                    )}
                  </Pressable>
                ) : null}
                {createAction ? (
                  <View ref={createAction.anchorRef} collapsable={false}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={createAction.accessibilityLabel}
                      style={({ pressed }) => [styles.iconButton, pressed && styles.pressed]}
                      onPress={createAction.onPress}
                    >
                      <Ionicons name="add" size={24} color={floraColors.greenLight} />
                    </Pressable>
                  </View>
                ) : null}
              </View>
            </>
          )}
        </View>
        {searchEnabled ? (
          <Animated.View
            style={[styles.searchLayer, searchStyle]}
            pointerEvents={searchLayerActive ? "box-none" : "none"}
            accessibilityElementsHidden={!searchLayerActive}
            importantForAccessibility={searchLayerActive ? "auto" : "no-hide-descendants"}
          >
            <View style={styles.searchBox}>
              <Ionicons name="search-outline" size={20} color={floraColors.gray} />
              <TextInput
                ref={inputRef}
                style={styles.searchInput}
                placeholder={placeholder}
                placeholderTextColor={floraColors.gray}
                value={value}
                onChangeText={onChangeText}
                onBlur={onSearchBlur}
                returnKeyType="search"
                autoCorrect={false}
                autoCapitalize="none"
                showSoftInputOnFocus
                editable={!selectionChrome}
              />
              <GesturePressable
                style={styles.searchClear}
                onPressIn={clearSearchQuery}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel="Очистить и закрыть поиск"
              >
                <Ionicons
                  name="add"
                  size={24}
                  color={floraColors.greenLight}
                  style={styles.searchClearIcon}
                />
              </GesturePressable>
            </View>
          </Animated.View>
        ) : null}
      </View>
      {belowRow}
    </>
  );
}

const styles = liveGridStyles(() => StyleSheet.create({
  chromeRow: {
    position: "relative",
    flexDirection: "row",
    alignItems: "center",
    gap: 0,
    minHeight: 45,
  },
  idleLayer: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: floraSpacing.grid,
  },
  searchLayer: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    paddingHorizontal: floraSpacing.grid,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: floraColors.bg,
  },
  title: {
    flexShrink: 1,
    marginLeft: floraSpacing.grid,
    color: floraColors.whiteTemplate,
    fontSize: 22,
    fontWeight: "300",
    letterSpacing: 0.88,
    lineHeight: 28,
  },
  titleRow: {
    flexShrink: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.gridFine,
  },
  titleBadge: {
    marginLeft: 0,
    paddingHorizontal: floraSpacing.gridFine * 2,
    paddingVertical: 3,
    borderRadius: 9999,
    backgroundColor: "#e8b84a",
  },
  titleBadgeText: {
    color: "#1a1408",
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.3,
  },
  spacer: {
    flex: 1,
    minWidth: 0,
  },
  trailingActions: {
    flexDirection: "row",
    alignItems: "center",
    // Чуть плотнее: поиск и «+» читаются одной группой.
    gap: 4,
    marginLeft: floraSpacing.gridFine,
  },
  iconButton: {
    width: 45,
    minHeight: 45,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  searchSavedMark: {
    position: "absolute",
    left: 2,
    bottom: 10,
  },
  iconButtonDisabled: {
    opacity: 0.45,
  },

  searchBox: {
    flex: 1,
    minWidth: 0,
    minHeight: 45,
    borderColor: floraColors.greenDark,
    borderWidth: 1,
    borderRadius: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    backgroundColor: "transparent",
  },
  searchInput: {
    flex: 1,
    minWidth: 0,
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    paddingVertical: 0,
  },
  searchClear: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  searchClearIcon: {
    transform: [{ rotate: "45deg" }],
  },
  pressed: {
    opacity: 0.72,
  },
}));

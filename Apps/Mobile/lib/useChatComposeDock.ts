import { useCallback, useEffect, useRef, useState } from "react";
import { Dimensions, Keyboard, Platform, type ViewStyle } from "react-native";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import {
  cancelAnimation,
  Easing as ReanimatedEasing,
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type AnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";
import {
  COMPOSE_BASELINE_FALLBACK_PX,
  emojiSlotTargetHeight,
} from "@/lib/messagesDockInsets";
import { floraSpacing } from "@/lib/theme";

/**
 * Compose dock v7 — KeyboardStickyView + KCSV (no manual translateY lift).
 * HANDOFF_STRATEGY: 'A' = OverKeyboardView when KB open (KB stays open).
 */

/** HANDOFF_STRATEGY from emoji-swap-spike gate — 'A' | 'D' */
export const HANDOFF_STRATEGY: "A" | "D" = "A";

const DockMode = {
  Idle: 0,
  Keyboard: 1,
  EmojiSlot: 2,
  EmojiClosing: 3,
  OverKeyboard: 4,
  EmojiToKeyboard: 5,
} as const;

type DockModeValue = (typeof DockMode)[keyof typeof DockMode];

function fallbackPanelHeight(): number {
  const windowHeight = Dimensions.get("window").height;
  return Math.round(Math.min(Math.max(windowHeight * 0.4, 260), 340));
}

const PANEL_ANIM_MS = Platform.OS === "ios" ? 250 : 200;
const PANEL_EASING = ReanimatedEasing.out(ReanimatedEasing.cubic);
const KB_HEIGHT_EPSILON_PX = 2;

export type DockGapDiagContext = {
  insetsBottom: number;
  systemNavBottomInset: number;
};

function logDockGapDiagnostics(
  tag: string,
  fields: {
    kbHeight?: number;
    shellHeight?: number;
    dockColumnHeight?: number;
    growth?: number;
    baseline?: number;
    keyboardOpen?: boolean;
    insetsBottom?: number;
    systemNavBottomInset?: number;
  },
  gapDiag?: DockGapDiagContext,
): void {
  if (!__DEV__) return;
  const windowHeight = Dimensions.get("window").height;
  const screenHeight = Dimensions.get("screen").height;
  console.debug("[chat-compose-dock] gap-diag", {
    tag,
    platform: Platform.OS,
    windowHeight,
    screenHeight,
    windowDeltaFromScreen: screenHeight - windowHeight,
    insetsBottom: gapDiag?.insetsBottom ?? fields.insetsBottom,
    systemNavBottomInset: gapDiag?.systemNavBottomInset ?? fields.systemNavBottomInset,
    ...fields,
  });
}

function blocksKeyboardOnEndZero(mode: DockModeValue): boolean {
  "worklet";
  return (
    mode === DockMode.EmojiSlot ||
    mode === DockMode.EmojiClosing ||
    mode === DockMode.OverKeyboard ||
    mode === DockMode.EmojiToKeyboard
  );
}

function canCalibrateComposeBaseline(mode: DockModeValue, emojiSlotOpen: boolean): boolean {
  return !emojiSlotOpen && (mode === DockMode.Idle || mode === DockMode.Keyboard);
}

export type ChatComposeDock = {
  emojiSlotStyle: AnimatedStyle<ViewStyle>;
  jumpBtnBottomStyle: AnimatedStyle<ViewStyle>;
  dockExtraPaddingSv: SharedValue<number>;
  dockColumnHeightSv: SharedValue<number>;
  freezeListSv: SharedValue<boolean>;
  composeBaselinePx: number;
  onComposeShellLayout: (height: number) => void;
  onDockColumnIdleLayout: (height: number) => void;
  setDeleteBarHeightPx: (height: number) => void;
  recalibrateComposeBaseline: () => void;
  overKeyboardVisible: boolean;
  emojiPanelMounted: boolean;
  emojiContentReady: boolean;
  emojiOpen: boolean;
  keyboardOpen: boolean;
  panelHeight: number;
  openEmoji: () => void;
  closeEmoji: () => void;
  showKeyboard: (focusInput: () => void) => void;
  resetDock: () => void;
};

export function useChatComposeDock(gapDiag?: DockGapDiagContext): ChatComposeDock {
  const gapDiagRef = useRef(gapDiag);
  gapDiagRef.current = gapDiag;
  const [composeBaselinePx, setComposeBaselinePx] = useState(0);
  const [panelHeight, setPanelHeight] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [emojiPanelMounted, setEmojiPanelMounted] = useState(false);
  const [emojiContentReady, setEmojiContentReady] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [overKeyboardVisible, setOverKeyboardVisible] = useState(false);

  const { height: kbHeightSv } = useReanimatedKeyboardAnimation();

  const emojiAccessoryPx = useSharedValue(0);
  const composeGrowthSv = useSharedValue(0);
  const deleteBarHeightSv = useSharedValue(0);
  const dockExtraPaddingSv = useSharedValue(0);
  const composeBaselineSv = useSharedValue(COMPOSE_BASELINE_FALLBACK_PX);
  const dockColumnHeightSv = useSharedValue(COMPOSE_BASELINE_FALLBACK_PX);
  const freezeListSv = useSharedValue(false);

  const dockModeSv = useSharedValue<DockModeValue>(DockMode.Idle);
  const keyboardOpenSv = useSharedValue(false);
  const panelOpenGenerationSv = useSharedValue(0);

  const dockModeRef = useRef<DockModeValue>(DockMode.Idle);
  const keyboardOpenRef = useRef(false);
  const lastKbHeightRef = useRef(0);
  const panelHeightRef = useRef(0);
  const composeBaselineRef = useRef(0);
  const panelOpenGenerationRef = useRef(0);
  const emojiSlotOpenRef = useRef(false);

  const setDockMode = useCallback((mode: DockModeValue) => {
    dockModeRef.current = mode;
    dockModeSv.value = mode;
    if (__DEV__) {
      console.debug("[chat-compose-dock] mode", mode);
    }
  }, [dockModeSv]);

  const syncKeyboardOpen = useCallback(
    (open: boolean) => {
      keyboardOpenRef.current = open;
      keyboardOpenSv.value = open;
      setKeyboardOpen(open);
      logDockGapDiagnostics(open ? "keyboard-open" : "keyboard-closed", {
        kbHeight: lastKbHeightRef.current,
        baseline: composeBaselineRef.current,
        growth: composeGrowthSv.value,
        keyboardOpen: open,
      }, gapDiagRef.current);
      if (open) {
        freezeListSv.value = false;
        if (dockModeRef.current === DockMode.Idle) {
          setDockMode(DockMode.Keyboard);
        }
        if (dockModeRef.current === DockMode.EmojiToKeyboard) {
          setDockMode(DockMode.Keyboard);
        }
        return;
      }
      if (dockModeRef.current === DockMode.Keyboard) {
        setDockMode(DockMode.Idle);
      }
    },
    [freezeListSv, keyboardOpenSv, setDockMode],
  );

  const syncKeyboardDismissed = useCallback(() => {
    keyboardOpenRef.current = false;
    keyboardOpenSv.value = false;
    setKeyboardOpen(false);
  }, [keyboardOpenSv]);

  const syncKeyboardClosed = useCallback(() => {
    syncKeyboardDismissed();
    setDockMode(DockMode.Idle);
  }, [setDockMode, syncKeyboardDismissed]);

  const resolvePanelHeight = useCallback(() => {
    const fromSession = lastKbHeightRef.current;
    return fromSession > 0 ? fromSession : fallbackPanelHeight();
  }, []);

  const clearEmojiPanelState = useCallback(() => {
    setEmojiOpen(false);
    setEmojiPanelMounted(false);
    setEmojiContentReady(false);
    setOverKeyboardVisible(false);
    emojiSlotOpenRef.current = false;
    panelHeightRef.current = 0;
    setPanelHeight(0);
  }, []);

  useEffect(() => {
    if (!gapDiag) return;
    logDockGapDiagnostics("thread-insets", {}, gapDiag);
  }, [gapDiag?.insetsBottom, gapDiag?.systemNavBottomInset]);

  useEffect(() => {
    emojiSlotOpenRef.current = emojiPanelMounted && !overKeyboardVisible;
  }, [emojiPanelMounted, overKeyboardVisible]);

  useAnimatedReaction(
    () => ({
      emoji: emojiAccessoryPx.value,
      growth: composeGrowthSv.value,
      deleteBar: deleteBarHeightSv.value,
      baseline: composeBaselineSv.value,
    }),
    (cur) => {
      const extra = cur.emoji + cur.growth + cur.deleteBar;
      dockExtraPaddingSv.value = extra;
      dockColumnHeightSv.value = cur.baseline + extra;
    },
  );

  const rememberKbHeight = useCallback((px: number) => {
    lastKbHeightRef.current = px;
    logDockGapDiagnostics("kb-height", {
      kbHeight: px,
      shellHeight: composeBaselineRef.current + composeGrowthSv.value,
      baseline: composeBaselineRef.current,
      growth: composeGrowthSv.value,
      keyboardOpen: keyboardOpenRef.current,
    }, gapDiagRef.current);
  }, [composeGrowthSv]);

  useAnimatedReaction(
    () => kbHeightSv.value,
    (h, prev) => {
      if (h > KB_HEIGHT_EPSILON_PX) {
        runOnJS(rememberKbHeight)(h);
        if (!keyboardOpenSv.value) {
          runOnJS(syncKeyboardOpen)(true);
        }
        return;
      }
      if ((prev ?? 0) > KB_HEIGHT_EPSILON_PX && h <= KB_HEIGHT_EPSILON_PX) {
        const mode = dockModeSv.value;
        if (blocksKeyboardOnEndZero(mode)) {
          runOnJS(syncKeyboardDismissed)();
          return;
        }
        if (mode === DockMode.Keyboard && keyboardOpenSv.value) {
          runOnJS(syncKeyboardClosed)();
        }
      }
    },
    [rememberKbHeight, syncKeyboardClosed, syncKeyboardDismissed, syncKeyboardOpen],
  );

  const emojiSlotStyle = useAnimatedStyle(() => ({
    height: emojiAccessoryPx.value,
    overflow: "hidden" as const,
  }));

  const jumpBtnBottomStyle = useAnimatedStyle(() => ({
    bottom: dockColumnHeightSv.value + floraSpacing.grid,
  }));

  const commitComposeBaseline = useCallback(
    (shellHeight: number) => {
      const prev = composeBaselineRef.current;
      const baseline = prev > 0 ? prev : shellHeight;
      if (prev !== baseline || prev <= 0) {
        composeBaselineRef.current = baseline;
        composeBaselineSv.value = baseline;
        setComposeBaselinePx(baseline);
      }
      composeGrowthSv.value = Math.max(0, shellHeight - baseline);
      logDockGapDiagnostics("shell-baseline", {
        shellHeight,
        baseline: composeBaselineRef.current,
        growth: composeGrowthSv.value,
        keyboardOpen: keyboardOpenRef.current,
        kbHeight: lastKbHeightRef.current,
      }, gapDiagRef.current);
    },
    [composeBaselineSv, composeGrowthSv],
  );

  const onComposeShellLayout = useCallback(
    (height: number) => {
      if (height <= 0) return;
      logDockGapDiagnostics("shell-layout", {
        shellHeight: height,
        baseline: composeBaselineRef.current,
        growth: composeGrowthSv.value,
        keyboardOpen: keyboardOpenRef.current,
        kbHeight: lastKbHeightRef.current,
      }, gapDiagRef.current);
      const mode = dockModeRef.current;
      const emojiSlotOpen = emojiSlotOpenRef.current;
      if (!canCalibrateComposeBaseline(mode, emojiSlotOpen)) {
        const baseline = composeBaselineRef.current || COMPOSE_BASELINE_FALLBACK_PX;
        composeGrowthSv.value = Math.max(0, height - baseline);
        return;
      }
      commitComposeBaseline(height);
    },
    [commitComposeBaseline, composeGrowthSv],
  );

  const onDockColumnIdleLayout = useCallback(
    (height: number) => {
      if (height <= 0) return;
      if (composeBaselineRef.current > 0) return;
      const mode = dockModeRef.current;
      if (!canCalibrateComposeBaseline(mode, emojiSlotOpenRef.current)) return;
      const shellOnly = height - deleteBarHeightSv.value;
      if (shellOnly <= 0) return;
      logDockGapDiagnostics("dock-column-layout", {
        dockColumnHeight: height,
        shellHeight: shellOnly,
        keyboardOpen: keyboardOpenRef.current,
        kbHeight: lastKbHeightRef.current,
      }, gapDiagRef.current);
      commitComposeBaseline(shellOnly);
    },
    [commitComposeBaseline, deleteBarHeightSv],
  );

  const recalibrateComposeBaseline = useCallback(() => {
    if (!canCalibrateComposeBaseline(dockModeRef.current, emojiSlotOpenRef.current)) {
      return;
    }
    composeBaselineRef.current = 0;
    composeBaselineSv.value = COMPOSE_BASELINE_FALLBACK_PX;
    setComposeBaselinePx(0);
    composeGrowthSv.value = 0;
  }, [composeBaselineSv, composeGrowthSv]);

  const setDeleteBarHeightPx = useCallback(
    (height: number) => {
      deleteBarHeightSv.value = height;
    },
    [deleteBarHeightSv],
  );

  const animateEmojiSlotOpen = useCallback(
    (targetH: number, generation: number) => {
      cancelAnimation(emojiAccessoryPx);
      emojiAccessoryPx.value = withTiming(
        targetH,
        { duration: PANEL_ANIM_MS, easing: PANEL_EASING },
        (finished) => {
          if (finished && generation === panelOpenGenerationSv.value) {
            runOnJS(setEmojiContentReady)(true);
          }
        },
      );
    },
    [emojiAccessoryPx, panelOpenGenerationSv],
  );

  const animateEmojiSlotClose = useCallback(
    (onEnd?: () => void) => {
      cancelAnimation(emojiAccessoryPx);
      emojiAccessoryPx.value = withTiming(
        0,
        { duration: PANEL_ANIM_MS, easing: PANEL_EASING },
        (finished) => {
          if (finished && onEnd) {
            runOnJS(onEnd)();
          }
        },
      );
    },
    [emojiAccessoryPx],
  );

  const openOverKeyboard = useCallback(
    (height: number, generation: number) => {
      panelHeightRef.current = height;
      setPanelHeight(height);
      setEmojiOpen(true);
      setEmojiContentReady(false);
      setEmojiPanelMounted(true);
      setOverKeyboardVisible(true);
      freezeListSv.value = true;
      setDockMode(DockMode.OverKeyboard);
      requestAnimationFrame(() => {
        if (generation === panelOpenGenerationRef.current) {
          setEmojiContentReady(true);
        }
      });
    },
    [freezeListSv, setDockMode],
  );

  const openEmojiSlot = useCallback(
    (height: number, generation: number) => {
      const targetH = emojiSlotTargetHeight(height);
      panelHeightRef.current = height;
      setPanelHeight(height);
      setEmojiOpen(true);
      setEmojiContentReady(false);
      setEmojiPanelMounted(true);
      emojiSlotOpenRef.current = true;
      setDockMode(DockMode.EmojiSlot);
      animateEmojiSlotOpen(targetH, generation);
    },
    [animateEmojiSlotOpen, setDockMode],
  );

  const openEmoji = useCallback(() => {
    if (dockModeRef.current === DockMode.EmojiClosing) return;
    if (
      dockModeRef.current === DockMode.EmojiSlot ||
      dockModeRef.current === DockMode.OverKeyboard
    ) {
      return;
    }
    if (dockModeRef.current === DockMode.EmojiToKeyboard) return;

    const height = resolvePanelHeight();
    const generation = panelOpenGenerationRef.current + 1;
    panelOpenGenerationRef.current = generation;
    panelOpenGenerationSv.value = generation;

    const kbOpen = keyboardOpenRef.current || kbHeightSv.value > KB_HEIGHT_EPSILON_PX;

    if (kbOpen && HANDOFF_STRATEGY === "A") {
      openOverKeyboard(height, generation);
      return;
    }

    if (kbOpen && HANDOFF_STRATEGY === "D") {
      freezeListSv.value = true;
      setDockMode(DockMode.EmojiToKeyboard);
      setEmojiOpen(true);
      setEmojiPanelMounted(true);
      emojiSlotOpenRef.current = true;
      panelHeightRef.current = height;
      setPanelHeight(height);
      animateEmojiSlotOpen(emojiSlotTargetHeight(height), generation);
      Keyboard.dismiss();
      return;
    }

    openEmojiSlot(height, generation);
  }, [
    animateEmojiSlotOpen,
    freezeListSv,
    kbHeightSv,
    openEmojiSlot,
    openOverKeyboard,
    panelOpenGenerationSv,
    resolvePanelHeight,
    setDockMode,
  ]);

  const closeEmoji = useCallback(() => {
    const mode = dockModeRef.current;
    if (mode === DockMode.EmojiClosing) return;

    panelOpenGenerationRef.current += 1;
    panelOpenGenerationSv.value = panelOpenGenerationRef.current;
    setEmojiContentReady(false);
    setDockMode(DockMode.EmojiClosing);

    if (mode === DockMode.OverKeyboard || overKeyboardVisible) {
      setOverKeyboardVisible(false);
      freezeListSv.value = false;
      clearEmojiPanelState();
      setDockMode(keyboardOpenRef.current ? DockMode.Keyboard : DockMode.Idle);
      return;
    }

    if (mode !== DockMode.EmojiSlot && mode !== DockMode.EmojiToKeyboard) {
      setDockMode(mode);
      return;
    }

    animateEmojiSlotClose(() => {
      clearEmojiPanelState();
      freezeListSv.value = false;
      setDockMode(keyboardOpenRef.current ? DockMode.Keyboard : DockMode.Idle);
    });
  }, [
    animateEmojiSlotClose,
    clearEmojiPanelState,
    freezeListSv,
    overKeyboardVisible,
    panelOpenGenerationSv,
    setDockMode,
  ]);

  const showKeyboard = useCallback(
    (focusInput: () => void) => {
      if (dockModeRef.current === DockMode.EmojiClosing) return;

      if (overKeyboardVisible) {
        setOverKeyboardVisible(false);
        freezeListSv.value = false;
        clearEmojiPanelState();
        setDockMode(DockMode.Keyboard);
        requestAnimationFrame(() => {
          requestAnimationFrame(focusInput);
        });
        return;
      }

      if (dockModeRef.current === DockMode.EmojiSlot || emojiSlotOpenRef.current) {
        freezeListSv.value = true;
        setDockMode(DockMode.EmojiToKeyboard);
        setEmojiOpen(false);
        setEmojiContentReady(false);
        animateEmojiSlotClose(() => {
          clearEmojiPanelState();
          setDockMode(DockMode.Idle);
          requestAnimationFrame(() => {
            requestAnimationFrame(focusInput);
          });
        });
        return;
      }

      focusInput();
    },
    [animateEmojiSlotClose, clearEmojiPanelState, freezeListSv, overKeyboardVisible, setDockMode],
  );

  const resetDockInner = useCallback(() => {
    cancelAnimation(emojiAccessoryPx);
    emojiAccessoryPx.value = 0;
    composeGrowthSv.value = 0;
    deleteBarHeightSv.value = 0;
    freezeListSv.value = false;
    dockModeSv.value = DockMode.Idle;
    keyboardOpenSv.value = false;
    panelOpenGenerationRef.current += 1;
    panelOpenGenerationSv.value = panelOpenGenerationRef.current;
    dockModeRef.current = DockMode.Idle;
    keyboardOpenRef.current = false;
    lastKbHeightRef.current = 0;
    emojiSlotOpenRef.current = false;
    composeBaselineRef.current = 0;
    composeBaselineSv.value = COMPOSE_BASELINE_FALLBACK_PX;
    setComposeBaselinePx(0);
    setKeyboardOpen(false);
    clearEmojiPanelState();
    Keyboard.dismiss();
    setDockMode(DockMode.Idle);
  }, [
    clearEmojiPanelState,
    composeBaselineSv,
    composeGrowthSv,
    deleteBarHeightSv,
    dockModeSv,
    emojiAccessoryPx,
    freezeListSv,
    keyboardOpenSv,
    panelOpenGenerationSv,
    setDockMode,
  ]);

  const resetDock = useCallback(() => {
    resetDockInner();
  }, [resetDockInner]);

  useEffect(() => {
    return () => {
      cancelAnimation(emojiAccessoryPx);
      emojiAccessoryPx.value = 0;
      freezeListSv.value = false;
    };
  }, [emojiAccessoryPx, freezeListSv]);

  return {
    emojiSlotStyle,
    jumpBtnBottomStyle,
    dockExtraPaddingSv,
    dockColumnHeightSv,
    freezeListSv,
    composeBaselinePx,
    onComposeShellLayout,
    onDockColumnIdleLayout,
    setDeleteBarHeightPx,
    recalibrateComposeBaseline,
    overKeyboardVisible,
    emojiPanelMounted,
    emojiContentReady,
    emojiOpen,
    keyboardOpen,
    panelHeight,
    openEmoji,
    closeEmoji,
    showKeyboard,
    resetDock,
  };
}

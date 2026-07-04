import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/**
 * Системная настройка «уменьшить движение» — как prefers-reduced-motion на вебе.
 * null — пока AccessibilityInfo не ответил; до этого не анимировать переходы.
 */
export function useFloraReduceMotion(): boolean | null {
  const [reduceMotion, setReduceMotion] = useState<boolean | null>(null);

  useEffect(() => {
    let mounted = true;

    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) {
        setReduceMotion(enabled);
      }
    });

    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  return reduceMotion;
}

/** true, пока reduce motion включён или настройка ещё не загружена. */
export function shouldSkipFloraMotion(reduceMotion: boolean | null): boolean {
  return reduceMotion !== false;
}

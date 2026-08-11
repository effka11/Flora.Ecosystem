import { getReducedMotion } from "@/lib/useReducedMotion";
import {
  cancelAnimation,
  Easing,
  runOnUI,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

export {
  BELOW_TIME_RESERVE_PX,
  TEXT_BASE_INSERT_LIFT_PX,
  estimateBlocksInsertLiftPx,
  estimateRowInsertLiftPx,
  estimateTextInsertLiftPx,
  estimateTextVisualLineCount,
  type InsertLiftEstimateCtx,
} from "@/lib/chatListInsertLiftEstimate";

/** Общий тайминг подъёма ленты при появлении сообщения у якоря. */
export const CHAT_INSERT_LIFT_MS = 220;

const LIFT_EASING = Easing.out(Easing.cubic);

/**
 * После insert у якоря: на кадр компенсируем скачок layout (+height), затем
 * анимируем в 0 — лента и новый пузырь едут одним transform-ом.
 *
 * `holdAvatarSv`: параллельно −H→0 для аватара хвоста (лента едет, аватар в кадре).
 * Передавать только при append в уже видимую peer-группу; при появлении аватара —
 * не передавать, чтобы он ехал вместе с сообщением.
 *
 * Старт через `runOnUI`: после idle DisplayLink/UI-runtime может не проснуться
 * от записи SharedValue с JS, пока не будет жеста — тогда withTiming «висит».
 */
export function playChatListInsertLift(
  insertLiftSv: SharedValue<number>,
  heightPx: number,
  holdAvatarSv?: SharedValue<number>,
): void {
  const h = Math.max(0, Math.round(heightPx));
  if (h <= 0) return;

  cancelAnimation(insertLiftSv);
  if (holdAvatarSv) cancelAnimation(holdAvatarSv);

  if (getReducedMotion()) {
    insertLiftSv.value = 0;
    if (holdAvatarSv) holdAvatarSv.value = 0;
    return;
  }

  const hold = holdAvatarSv;
  runOnUI(() => {
    "worklet";
    const timing = {
      duration: CHAT_INSERT_LIFT_MS,
      easing: LIFT_EASING,
    };
    insertLiftSv.value = h;
    insertLiftSv.value = withTiming(0, timing);
    if (hold) {
      hold.value = -h;
      hold.value = withTiming(0, timing);
    }
  })();
}

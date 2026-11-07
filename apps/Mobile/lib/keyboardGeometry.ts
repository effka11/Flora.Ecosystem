/**
 * Сверка геометрии IME с нативным состоянием.
 *
 * Провайдер клавиатуры обновляет `height/progress` из move-событий. После
 * activity-return (системный пикер, камера) эти события могут не дойти:
 * `height` остаётся 0, и док стоит под клавиатурой — поле ввода «проваливается».
 *
 * Источником сверки обязаны быть события RN `Keyboard` (didShow/didHide): на
 * Android их шлёт `ReactRootView` по каждому global layout, сравнивая живые
 * window-insets с флагом видимости. Поэтому после возврата из activity они
 * переигрывают пропущенный переход. События/состояние KeyboardController так
 * не умеют: они приходят только из insets-анимации, которой при возврате может
 * не быть, — сверка по ним повторяет уже потерянное событие.
 */
export type KeyboardGeometry = {
  /** Как у провайдера: 0 или отрицательная высота открытой клавиатуры. */
  heightPx: number;
  /** 0..1, 1 — клавиатура полностью открыта. */
  progress: number;
};

const DEFAULT_EPSILON_PX = 2;
const SETTLED_PROGRESS = 0.999;
const IDLE_PROGRESS = 0.01;

/**
 * Высота IME в координатах провайдера из высоты события RN `Keyboard`.
 *
 * Android: RN отдаёт `ime.bottom - systemBars.bottom`, а провайдер с
 * translucent navigation bar считает `ime.bottom` целиком — разница равна
 * нижнему системному инсету. Без поправки док встанет на navInset ниже
 * клавиатуры. iOS: обе высоты — высота кадра клавиатуры.
 */
export function keyboardHeightForDock(args: {
  android: boolean;
  /** `endCoordinates.height` из события RN Keyboard. */
  eventHeightPx: number;
  /** Тот же нижний инсет, что уходит в keyboardStickyOffsets. */
  navInsetPx: number;
}): number {
  const height = Math.max(0, args.eventHeightPx);
  if (!args.android) return height;
  return height + Math.max(0, args.navInsetPx);
}

/**
 * `null` — текущая геометрия уже совпадает с нативной, трогать нечего.
 */
export function reconciledKeyboardGeometry(args: {
  visible: boolean;
  /** Положительная высота из didShow / KeyboardController.state(). */
  nativeHeightPx: number;
  currentHeightPx: number;
  currentProgress: number;
  epsilonPx?: number;
}): KeyboardGeometry | null {
  const epsilon = args.epsilonPx ?? DEFAULT_EPSILON_PX;
  if (args.visible) {
    const target = Math.max(0, args.nativeHeightPx);
    if (target <= epsilon) return null;
    const alreadyLifted =
      args.currentHeightPx <= -target + epsilon && args.currentProgress >= SETTLED_PROGRESS;
    if (alreadyLifted) return null;
    return { heightPx: -target, progress: 1 };
  }
  const alreadyIdle =
    args.currentHeightPx >= -epsilon && args.currentProgress <= IDLE_PROGRESS;
  if (alreadyIdle) return null;
  return { heightPx: 0, progress: 0 };
}

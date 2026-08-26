/**
 * Телеграмный push чата в языке Flora. Один shared progress ведёт обе сцены:
 * 0 — список в покое, 1 — чат на месте. Чат заезжает справа непрозрачным
 * слоем (`translateX = (1-p)·width`), список остаётся на месте с лёгким
 * параллаксом влево и затемнением (`-p·PARALLAX·width`, dim `p·DIM`) — без
 * кроссфейда экранов. Кривая и темп — ENERGETIC_OPEN, та же энергия, что у
 * переключения вкладок и подвкладок; назад — то же самое зеркально (см.
 * EXIT_MS/EXIT_EASING).
 *
 * Нативный переход выключен (`presentation: "transparentModal"` +
 * `animation: "none"`): RNS свапает сцены мгновенно и держит список видимым
 * под прозрачным экраном треда, хореографию целиком ведёт Reanimated на
 * UI-потоке. Progress — процесс-глобальный makeMutable (паттерн
 * tabRouteCover): экраны живут в разных ветках native stack, React-контекст
 * ради одного значения не заводим.
 *
 * Протокол — как push в Telegram/iOS: едет ОДИН слой, и этот слой с первого
 * кадра — настоящий чат (шапка из параметров строки + док), а не пустая
 * подложка. Тап по строке → armChatPushEnter() только взводит переход
 * (движения нет, отклик несёт нажатая строка) → router.push → первый коммит
 * экрана треда, runChatPushEnter() из useLayoutEffect играет весь слайд
 * 0→1 разом (ENERGETIC_OPEN). Отсюда единственная фаза движения: нет ни
 * дёрганья списка до маунта, ни подмены подложки на чат в полёте.
 *
 * Назад: beforeRemove → runChatPushExit() ведёт progress к 0 и после этого
 * отпускает отложенный pop. Если push не состоялся — страховочный таймер
 * возвращает 0.
 */
import { AccessibilityInfo } from "react-native";
import {
  cancelAnimation,
  makeMutable,
  runOnJS,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { ENERGETIC_OPEN_EASING, ENERGETIC_OPEN_MS } from "@/lib/energeticSettle";

const ENTER_MS = ENERGETIC_OPEN_MS;
const ENTER_EASING = ENERGETIC_OPEN_EASING;
/**
 * Возврат парирует заезд — тот же duration-3 и та же ease-out, что у входа
 * (контракт закрытия меню-гамбургера: OPEN_MS/OPEN_EASING = CLOSE_MS/EASING).
 * Не ENERGETIC_CLOSE: у него другой темп и ease-in, из-за чего обратный ход
 * читался иначе, чем прямой, — жест переставал быть зеркалом.
 */
const EXIT_MS = ENTER_MS;
const EXIT_EASING = ENTER_EASING;

/** 0 — список в покое, 1 — чат полностью накрыл список. */
export const chatPushProgress = makeMutable(0);

/** Параллакс списка — доля ширины экрана (iOS/Telegram ≈ 30%). */
export const CHAT_PUSH_PARALLAX = 0.3;
/** Затемнение списка на полном ходу чата. */
export const CHAT_PUSH_DIM = 0.32;

/** Push не состоялся (гонка/ошибка) — вернуть список на место. */
const CLAIM_TIMEOUT_MS = 1200;

let armed = false;
let armSafetyTimer: ReturnType<typeof setTimeout> | null = null;
let exiting = false;

/**
 * Играет ли прямо сейчас анимация возврата. Экран треда держит на это время
 * фоновую дорасшифровку истории: её коммит (setRows → пересборка listData →
 * ре-рендер видимых ячеек) попадает мимо кадров ухода, а сам экран всё равно
 * размонтируется по завершении анимации.
 */
export function isChatPushExiting(): boolean {
  return exiting;
}

/**
 * Reduce motion читаем сами (не хуком): arm зовут и plain-функции
 * (openGroupChat). До ответа AccessibilityInfo движение пропускаем — та же
 * политика, что shouldSkipFloraMotion.
 */
let reduceMotion: boolean | null = null;
void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
  reduceMotion ??= enabled;
});
AccessibilityInfo.addEventListener("reduceMotionChanged", (enabled) => {
  reduceMotion = enabled;
});

function skipMotion(): boolean {
  return reduceMotion !== false;
}

function clearArmSafety(): void {
  if (armSafetyTimer != null) {
    clearTimeout(armSafetyTimer);
    armSafetyTimer = null;
  }
}

/**
 * Зовут строки списка синхронно ПЕРЕД router.push. Только взводит переход:
 * двигать список до появления чата нельзя — это читается как отдельная
 * первая фаза (см. заголовок модуля).
 */
export function armChatPushEnter(): void {
  if (skipMotion()) return;
  armed = true;
  exiting = false;
  clearArmSafety();
  cancelAnimation(chatPushProgress);
  chatPushProgress.value = 0;
  // Экран треда так и не смонтировался (гонка/ошибка навигации): снимаем
  // взвод, чтобы следующий маунт не сыграл вход задним числом.
  armSafetyTimer = setTimeout(() => {
    armed = false;
  }, CLAIM_TIMEOUT_MS);
}

/**
 * Стартовое значение `driven` экрана треда: читается в первом рендере, ДО
 * эффектов — armed-экран обязан выйти на первый кадр уже уведённым за правый
 * край, иначе кадр-вспышка чата на месте перед слайдом.
 */
export function isChatPushEnterArmed(): boolean {
  return armed && !skipMotion();
}

/**
 * Первый коммит экрана треда (useLayoutEffect): играет весь слайд разом —
 * движение начинается кадром, в котором чат уже нарисован. Без тапа (deep
 * link, reduce motion) — чат встаёт на место мгновенно.
 *
 * `driven` — флаг «слайд ведёт translateX экрана»: снимается по завершении
 * входа, чтобы чужие переходы поверх (второй чат из уведомления) не таскали
 * уже посаженный экран. Прерванный вход (finished=false — например, сразу
 * нажали «назад») флаг не снимает: им дальше управляет exit.
 */
export function runChatPushEnter(driven: SharedValue<boolean>): void {
  clearArmSafety();
  const play = armed && !skipMotion();
  armed = false;
  exiting = false;
  cancelAnimation(chatPushProgress);
  if (!play) {
    driven.value = false;
    chatPushProgress.value = 1;
    return;
  }
  driven.value = true;
  chatPushProgress.value = 0;
  chatPushProgress.value = withTiming(
    1,
    { duration: ENTER_MS, easing: ENTER_EASING },
    (finished) => {
      "worklet";
      if (finished) {
        driven.value = false;
      }
    },
  );
}

/**
 * Назад из чата — зеркало входа: тот же progress по той же кривой и за то же
 * время, только 1→0 (чат уезжает вправо, список возвращается из параллакса и
 * затемнения). По завершении — onDone (dispatch отложенного pop).
 * false — анимировать нечего (reduce motion / список уже на месте, например
 * чат поверх чата): пусть pop идёт немедленно.
 */
export function runChatPushExit(
  driven: SharedValue<boolean>,
  onDone: () => void,
): boolean {
  if (skipMotion() || chatPushProgress.value <= 0.01) return false;
  clearArmSafety();
  armed = false;
  exiting = true;
  driven.value = true;
  const finish = () => {
    exiting = false;
    onDone();
  };
  cancelAnimation(chatPushProgress);
  chatPushProgress.value = withTiming(
    0,
    { duration: EXIT_MS, easing: EXIT_EASING },
    () => {
      "worklet";
      // Даже прерванная анимация обязана отпустить pop — иначе экран завис.
      runOnJS(finish)();
    },
  );
  return true;
}

/**
 * Страховка списка на focus: к моменту возврата progress обязан быть 0
 * (exit уже отыграл); чинит любые аварийные пути (pop без анимации, краш
 * перехода).
 */
export function resetChatPushProgress(): void {
  clearArmSafety();
  armed = false;
  exiting = false;
  cancelAnimation(chatPushProgress);
  chatPushProgress.value = 0;
}

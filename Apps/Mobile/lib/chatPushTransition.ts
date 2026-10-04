/**
 * Телеграмный push в языке Flora: чат поверх списка сообщений и создание
 * поста поверх ленты. У каждого свой progress (экраны не делят жест):
 * 0 — список в покое, 1 — верхний экран на месте. Верхний экран заезжает
 * справа непрозрачным слоем (`translateX = (1-p)·width`), список остаётся
 * с лёгким параллаксом влево и затемнением (`-p·PARALLAX·width`, dim `p·DIM`)
 * — без кроссфейда. Кривая и темп — ENERGETIC_OPEN, та же энергия, что у
 * переключения вкладок; назад — то же зеркально (EXIT_MS/EXIT_EASING).
 *
 * Нативный переход выключен (`presentation: "transparentModal"` +
 * `animation: "none"`): RNS свапает сцены мгновенно и держит список видимым
 * под прозрачным экраном, хореографию ведёт Reanimated на UI-потоке.
 * Progress — процесс-глобальный makeMutable (паттерн tabRouteCover): экраны
 * живут в разных ветках native stack, React-контекст ради одного значения
 * не заводим.
 *
 * Протокол — как push в Telegram/iOS: едет ОДИН слой, и этот слой с первого
 * кадра — настоящий экран, а не пустая подложка. Тап → arm*Enter() только
 * взводит переход (движения нет) → router.push → первый коммит верхнего
 * экрана, run*Enter() из useLayoutEffect играет весь слайд 0→1 разом.
 *
 * Назад: beforeRemove → run*Exit() ведёт progress к 0 и после этого
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

/** Параллакс списка — доля ширины экрана (iOS/Telegram ≈ 30%). */
export const CHAT_PUSH_PARALLAX = 0.3;
/** Затемнение списка на полном ходу верхнего экрана. */
export const CHAT_PUSH_DIM = 0.32;

/** Push не состоялся (гонка/ошибка) — вернуть список на место. */
const CLAIM_TIMEOUT_MS = 1200;

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

type CoverPush = {
  /** 0 — список в покое, 1 — верхний экран полностью накрыл список. */
  progress: SharedValue<number>;
  isExiting: () => boolean;
  armEnter: () => void;
  isEnterArmed: () => boolean;
  runEnter: (driven: SharedValue<boolean>) => void;
  runExit: (driven: SharedValue<boolean>, onDone: () => void) => boolean;
  reset: () => void;
};

function createCoverPush(): CoverPush {
  const progress = makeMutable(0);
  let armed = false;
  let exiting = false;
  let armSafetyTimer: ReturnType<typeof setTimeout> | null = null;

  function clearArmSafety(): void {
    if (armSafetyTimer != null) {
      clearTimeout(armSafetyTimer);
      armSafetyTimer = null;
    }
  }

  return {
    progress,
    isExiting: () => exiting,
    /**
     * Синхронно ПЕРЕД router.push. Только взводит переход: двигать список
     * до появления верхнего экрана нельзя — это отдельная первая фаза.
     */
    armEnter() {
      if (skipMotion()) return;
      armed = true;
      exiting = false;
      clearArmSafety();
      cancelAnimation(progress);
      progress.value = 0;
      // Верхний экран так и не смонтировался: снимаем взвод, чтобы следующий
      // маунт не сыграл вход задним числом.
      armSafetyTimer = setTimeout(() => {
        armed = false;
      }, CLAIM_TIMEOUT_MS);
    },
    /** Первый рендер, до эффектов: armed-экран уже за правым краем. */
    isEnterArmed() {
      return armed && !skipMotion();
    },
    /**
     * Первый коммит верхнего экрана: весь слайд разом. Без тапа (deep link,
     * reduce motion) экран встаёт на место мгновенно. `driven` снимается по
     * завершении входа; прерванный вход (finished=false) флаг не снимает.
     */
    runEnter(driven) {
      clearArmSafety();
      const play = armed && !skipMotion();
      armed = false;
      exiting = false;
      cancelAnimation(progress);
      if (!play) {
        driven.value = false;
        progress.value = 1;
        return;
      }
      driven.value = true;
      progress.value = 0;
      progress.value = withTiming(
        1,
        { duration: ENTER_MS, easing: ENTER_EASING },
        (finished) => {
          "worklet";
          if (finished) {
            driven.value = false;
          }
        },
      );
    },
    /**
     * Зеркало входа: 1→0, затем onDone (dispatch отложенного pop).
     * false — анимировать нечего: pop идёт немедленно.
     */
    runExit(driven, onDone) {
      if (skipMotion() || progress.value <= 0.01) return false;
      clearArmSafety();
      armed = false;
      exiting = true;
      driven.value = true;
      const finish = () => {
        exiting = false;
        onDone();
      };
      cancelAnimation(progress);
      progress.value = withTiming(
        0,
        { duration: EXIT_MS, easing: EXIT_EASING },
        () => {
          "worklet";
          // Даже прерванная анимация обязана отпустить pop — иначе экран завис.
          runOnJS(finish)();
        },
      );
      return true;
    },
    /** Focus списка: exit уже отыграл; чинит pop без анимации. */
    reset() {
      clearArmSafety();
      armed = false;
      exiting = false;
      cancelAnimation(progress);
      progress.value = 0;
    },
  };
}

const chatPush = createCoverPush();
const composePush = createCoverPush();

/** 0 — список диалогов в покое, 1 — чат полностью накрыл список. */
export const chatPushProgress = chatPush.progress;

/**
 * Играет ли прямо сейчас анимация возврата из чата. Экран треда держит на
 * это время фоновую дорасшифровку истории.
 */
export function isChatPushExiting(): boolean {
  return chatPush.isExiting();
}

/** Строка списка, синхронно перед router.push. */
export function armChatPushEnter(): void {
  chatPush.armEnter();
}

export function isChatPushEnterArmed(): boolean {
  return chatPush.isEnterArmed();
}

export function runChatPushEnter(driven: SharedValue<boolean>): void {
  chatPush.runEnter(driven);
}

export function runChatPushExit(
  driven: SharedValue<boolean>,
  onDone: () => void,
): boolean {
  return chatPush.runExit(driven, onDone);
}

export function resetChatPushProgress(): void {
  chatPush.reset();
}

/** 0 — лента в покое, 1 — создание поста полностью накрыло ленту. */
export const composePushProgress = composePush.progress;

/** «Создать пост» в шапке ленты, синхронно перед router.push. */
export function armComposePushEnter(): void {
  composePush.armEnter();
}

export function isComposePushEnterArmed(): boolean {
  return composePush.isEnterArmed();
}

export function runComposePushEnter(driven: SharedValue<boolean>): void {
  composePush.runEnter(driven);
}

export function runComposePushExit(
  driven: SharedValue<boolean>,
  onDone: () => void,
): boolean {
  return composePush.runExit(driven, onDone);
}

export function resetComposePushProgress(): void {
  composePush.reset();
}

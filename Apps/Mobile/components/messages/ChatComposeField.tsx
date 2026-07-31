import { Ionicons } from "@expo/vector-icons";
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEvent,
  type TextLayoutEventData,
} from "react-native";
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { KeyboardController } from "react-native-keyboard-controller";
import { ChatComposeImageStrip } from "@/components/messages/ChatComposeImageStrip";
import { ChatVoiceComposeBar } from "@/components/messages/ChatVoiceComposeBar";
import { ENERGETIC_OPEN_EASING } from "@/lib/energeticSettle";
import type { DraftMessageImage } from "@/lib/useMessageComposeImages";
import { floraColors, floraMessages, floraSpacing } from "@/lib/theme";

/** Высота инпута (border-box) под n видимых строк. */
function composeInputHeight(rows: number): number {
  return (
    floraMessages.composeInputLineHeight * rows + 2 * floraMessages.composeInputPaddingVertical
  );
}

/** Потолок роста: высота инпута с текстом — всегда она (см. inputStyle). */
const COMPOSE_INPUT_MAX_HEIGHT = composeInputHeight(floraMessages.composeInputMaxLines);

/** Рост/сжатие поля — паритет web `transition: height 0.18s var(--flora-ease-out)`. */
const COMPOSE_GROW_TIMING = {
  duration: floraMessages.composeGrowDurationMs,
  easing: ENERGETIC_OPEN_EASING,
} as const;

/** Расхождение «цель роста ↔ измерение», ниже которого это округление пикселей. */
const SHELL_HEIGHT_EPSILON_PX = 1.5;

export type ChatComposeFieldHandle = {
  insertToken: (token: string) => void;
  focusInput: () => void;
  blurInput: () => void;
  /**
   * Поднять IME. После dismiss({keepFocus}) инпут остаётся сфокусированным,
   * и JS focus() — no-op; setFocusTo("current") форсит показ клавиатуры нативно.
   */
  showInputKeyboard: () => void;
  /** Очистить черновик — после успешной отправки. */
  clearText: () => void;
};

type Props = {
  /**
   * Черновик живёт в самом поле, а экран получает его в момент отправки: иначе
   * каждый символ перерисовывал бы весь тред (лента, меню, шапка) и рост поля
   * начинался бы уже после этой работы.
   */
  onSend: (text: string) => void;
  sending: boolean;
  disabled: boolean;
  placeholder?: string;
  bottomInset?: number;
  emojiAccessoryActive: boolean;
  /**
   * Единый тап по кнопке эмодзи/клавиатуры: решение «что делать» принимает
   * хук дока по своему свежему ref-состоянию, а не по prop-у рендера —
   * быстрая серия тапов не расходится с фактическим режимом.
   */
  onToggleEmoji: () => void;
  images?: DraftMessageImage[];
  onRemoveImageAt?: (index: number) => void;
  onPickImages?: () => void;
  hasPendingImages?: boolean;
  /**
   * Высота оболочки для дока: измерение покоя, а на смене числа строк — сразу
   * посчитанная цель, ещё до того, как поле до неё доедет.
   */
  onShellLayout?: (height: number) => void;
  /**
   * Догон ленты: сколько ей осталось проехать до уже применённой ступени
   * зазора. Ход у ленты и у pill один и тот же, поэтому и величина одна: поле
   * ведёт её своей кривой, а лента едет этим же числом (см. listLiftStyle).
   */
  growthHoldSv: SharedValue<number>;
  onInputFocus?: () => void;
  /** Draft text changes (keeps draft local; parent uses for typing pings). */
  onTextChange?: (text: string) => void;
  voiceMode?: boolean;
  voiceRecording?: boolean;
  voiceShowStopControl?: boolean;
  voiceRecordingStartedAt?: number | null;
  voiceWaveform?: number[];
  voiceTranscoding?: boolean;
  voiceCanSend?: boolean;
  onStartVoice?: () => void;
  onDiscardVoice?: () => void;
  onStopVoice?: () => void;
  onSendVoice?: () => void;
};

export const ChatComposeField = forwardRef<ChatComposeFieldHandle, Props>(function ChatComposeField(
  {
    onSend,
    sending,
    disabled,
    placeholder = "Сообщение",
    bottomInset = floraSpacing.grid,
    emojiAccessoryActive,
    onToggleEmoji,
    images = [],
    onRemoveImageAt,
    onPickImages,
    hasPendingImages = false,
    onShellLayout,
    growthHoldSv,
    onInputFocus,
    onTextChange,
    voiceMode = false,
    voiceRecording = false,
    voiceShowStopControl = false,
    voiceRecordingStartedAt = null,
    voiceWaveform = [],
    voiceTranscoding = false,
    voiceCanSend = false,
    onStartVoice,
    onDiscardVoice,
    onStopVoice,
    onSendVoice,
  },
  ref,
) {
  const inputRef = useRef<TextInput>(null);
  const [value, setValue] = useState("");
  const valueRef = useRef(value);
  valueRef.current = value;
  const onTextChangeRef = useRef(onTextChange);
  onTextChangeRef.current = onTextChange;

  const handleChangeText = (next: string) => {
    setValue(next);
    onTextChangeRef.current?.(next);
  };
  /**
   * Высота зоны текста, какой её видит React-дерево. Без неё каждый символ
   * черновика коммитил бы зону однострочной: useAnimatedStyle отдаёт в коммит
   * не текущее значение, а замороженное на первом рендере (PropsFilter
   * кеширует initial один раз), и на многострочном поле pill вместе с текстом
   * дёргался бы вниз-вверх на каждую букву. Меняется только по осадке
   * анимации — в этот момент она тождественна анимированной.
   */
  const [settledInputHeight, setSettledInputHeight] = useState(composeInputHeight(1));
  const inputRowsRef = useRef(1);
  /** Цель роста (ступень) и текущая, едущая к ней высота зоны текста. */
  const inputTargetSv = useSharedValue(composeInputHeight(1));
  const inputHeightSv = useSharedValue(composeInputHeight(1));
  /**
   * Высота оболочки на одной строке: измеренная минус уже набранный рост. Из
   * неё считается цель для дока в момент смены числа строк.
   */
  const shellBaseHeightRef = useRef(0);
  /** Пока едет рост, onLayout меряет промежуточные кадры — их нельзя отдавать доку. */
  const growingRef = useRef(false);
  const droppedShellHeightRef = useRef(0);
  const shellTargetHeightRef = useRef(0);
  const selectionRef = useRef({ start: 0, end: 0 });
  const isEmpty = value.length === 0;
  const canSendText =
    (value.trim().length > 0 || images.length > 0) && !sending && !disabled && !hasPendingImages;
  const canStartVoice =
    !voiceMode &&
    value.trim().length === 0 &&
    images.length === 0 &&
    !sending &&
    !disabled &&
    !hasPendingImages;

  const onSelectionChange = useCallback((event: TextInputSelectionChangeEvent) => {
    selectionRef.current = event.nativeEvent.selection;
  }, []);

  const commitShellHeight = useCallback(
    (height: number) => {
      shellBaseHeightRef.current =
        height - (inputRowsRef.current - 1) * floraMessages.composeInputLineHeight;
      onShellLayout?.(height);
    },
    [onShellLayout],
  );

  const reportShellLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const height = event.nativeEvent.layout.height;
      if (growingRef.current) {
        droppedShellHeightRef.current = height;
        return;
      }
      commitShellHeight(height);
    },
    [commitShellHeight],
  );

  /**
   * Рост доехал: измерение снова живое. Если оно разошлось с целью (сменился
   * инсет, появилась полоса картинок), доводим док фактической высотой.
   */
  const onGrowSettled = useCallback(() => {
    growingRef.current = false;
    setSettledInputHeight(composeInputHeight(inputRowsRef.current));
    const measured = droppedShellHeightRef.current;
    droppedShellHeightRef.current = 0;
    if (measured <= 0) return;
    if (Math.abs(measured - shellTargetHeightRef.current) <= SHELL_HEIGHT_EPSILON_PX) return;
    commitShellHeight(measured);
  }, [commitShellHeight]);

  /**
   * Строки считает зеркало, а не нативный авторост: на Android StaticLayout не
   * применяет lineHeight к пустой последней строке, поэтому после Enter поле
   * подрастало на неполную строку и добирало остаток только на первом символе.
   *
   * Число строк не рендерится — оно ведёт только высоту зоны текста, то есть
   * shared value. Рост поля не стоит ни одного React-коммита: инпут прижат к
   * ВЕРХУ зоны и едет вместе с её верхней гранью — как в web с
   * `transition: height`, — а новая строка проявляется снизу по мере роста.
   */
  const onMirrorTextLayout = useCallback(
    (event: NativeSyntheticEvent<TextLayoutEventData>) => {
      const rows = Math.min(
        Math.max(event.nativeEvent.lines.length, 1),
        floraMessages.composeInputMaxLines,
      );
      if (rows === inputRowsRef.current) return;
      inputRowsRef.current = rows;

      // Цель — сразу, кривая — от текущей высоты: серия быстрых переносов
      // подхватывается с той точки, где рост застало новое число строк.
      const target = composeInputHeight(rows);
      inputTargetSv.value = target;
      inputHeightSv.value = withTiming(target, COMPOSE_GROW_TIMING, (finished) => {
        "worklet";
        if (finished) runOnJS(onGrowSettled)();
      });

      growingRef.current = true;
      const base = shellBaseHeightRef.current;
      shellTargetHeightRef.current =
        base > 0 ? base + (rows - 1) * floraMessages.composeInputLineHeight : 0;
      // Цель дока — тем же коммитом: ступень и недобор (growthHoldSv) гасят
      // друг друга в этом кадре, а дальше лента едет ровно кривой pill.
      if (shellTargetHeightRef.current > 0) onShellLayout?.(shellTargetHeightRef.current);
    },
    [inputHeightSv, inputTargetSv, onGrowSettled, onShellLayout],
  );

  /**
   * Одна величина хода на поле и ленту: сколько зоне текста осталось добрать до
   * ступени. Считается на UI-потоке из той же анимации — разъехаться нечему.
   */
  useAnimatedReaction(
    () => inputTargetSv.value - inputHeightSv.value,
    (hold) => {
      growthHoldSv.value = hold;
    },
  );

  const inputZoneAnimatedStyle = useAnimatedStyle(() => ({
    height: inputHeightSv.value,
  }));

  /**
   * Осевшая высота стоит ПОСЛЕ анимированной: в коммит уходит именно она (у
   * анимированной там замороженный initial), а кадры анимации всё равно пишутся
   * поверх с UI-потока. Массив стабилен между сменами строк — на символ
   * черновика у зоны вообще нет обновления стиля.
   */
  const inputZoneStyle = useMemo(
    () => [styles.inputWrap, inputZoneAnimatedStyle, { height: settledInputHeight }],
    [inputZoneAnimatedStyle, settledInputHeight],
  );

  /**
   * С текстом инпут всегда ростом в потолок и не участвует в анимации вовсе.
   * Высота по числу строк приезжала бы кадром позже самого текста (строки
   * считает зеркало), и на этом кадре контент выше своего окна: окно текста на
   * одной строке — ровно 22px, а перенос делает контент 44px. Android в такой
   * ситуации доскраливает каретку внутрь инпута, то есть уводит текст на строку
   * вверх, а следующим кадром высота приезжает и скролл отыгрывает назад — это
   * и есть дёрганье туда-сюда, одинаковое хоть с анимацией, хоть без неё.
   * Пустое поле — исключение: там высота в одну строку нужна центрированию
   * каретки (см. textAlignVertical), а переполнить окно нечем.
   */
  const inputStyle = useMemo(
    () => [styles.input, { height: isEmpty ? composeInputHeight(1) : COMPOSE_INPUT_MAX_HEIGHT }],
    [isEmpty],
  );

  const insertToken = useCallback((token: string) => {
    const current = valueRef.current;
    const start = Math.min(selectionRef.current.start, current.length);
    const end = Math.min(selectionRef.current.end, current.length);
    const next = current.slice(0, start) + token + current.slice(end);
    const caret = start + token.length;
    setValue(next);
    onTextChangeRef.current?.(next);
    selectionRef.current = { start: caret, end: caret };
    requestAnimationFrame(() => {
      inputRef.current?.setNativeProps({ selection: { start: caret, end: caret } });
    });
  }, []);

  const clearText = useCallback(() => {
    setValue("");
    onTextChangeRef.current?.("");
    selectionRef.current = { start: 0, end: 0 };
  }, []);

  const showInputKeyboard = useCallback(() => {
    if (inputRef.current?.isFocused()) {
      // Фокус сохранён после dismiss({keepFocus}) — JS focus() был бы no-op.
      KeyboardController.setFocusTo("current");
      return;
    }
    inputRef.current?.focus();
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      insertToken,
      focusInput: () => inputRef.current?.focus(),
      blurInput: () => inputRef.current?.blur(),
      showInputKeyboard,
      clearText,
    }),
    [clearText, insertToken, showInputKeyboard],
  );

  const handleEmojiPress = useCallback(() => {
    if (disabled) return;
    if (voiceMode) {
      onDiscardVoice?.();
    }
    onToggleEmoji();
  }, [disabled, onDiscardVoice, onToggleEmoji, voiceMode]);

  const handleInputFocus = useCallback(() => {
    onInputFocus?.();
  }, [onInputFocus]);

  const emojiChrome = emojiAccessoryActive;

  return (
    <View
      onLayout={reportShellLayout}
      style={[
        styles.shell,
        {
          paddingBottom: bottomInset + floraMessages.composeShellPaddingBottomExtra,
        },
      ]}
    >
      {!voiceMode && images.length > 0 && onRemoveImageAt ? (
        <ChatComposeImageStrip images={images} onRemoveAt={onRemoveImageAt} />
      ) : null}

      <View style={styles.fieldZone}>
        {/* В voice-режиме строка поля остаётся в потоке С ПОЛНЫМ layout-ом
            (только opacity:0 под оверлеем): TextInput не перемещается и не
            клипается — Android IME не получает поводов закрыться, а высота
            shell тождественна текстовому режиму (baseline не плывёт). */}
        <View
          style={[styles.field, voiceMode && styles.fieldUnderVoice]}
          pointerEvents={voiceMode ? "none" : "auto"}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Прикрепить фото"
            style={({ pressed }) => [styles.chromeBtn, pressed && styles.chromeBtnPressed]}
            disabled={disabled || !onPickImages}
            onPress={onPickImages}
          >
            <Ionicons name="add" size={20} color={disabled || !onPickImages ? floraColors.gray : floraColors.greenLight} />
          </Pressable>

          <Animated.View style={inputZoneStyle}>
            {/* Зеркало строк: та же ширина и типографика, тот же textBreakStrategy —
                иначе переносы разойдутся с инпутом. Хвостовой \u200b держит пустую
                последнюю строку в счёте. numberOfLines обрезает работу по потолку. */}
            <Text
              pointerEvents="none"
              style={styles.inputMirror}
              onTextLayout={onMirrorTextLayout}
              numberOfLines={floraMessages.composeInputMaxLines}
              textBreakStrategy="simple"
            >
              {`${value}\u200b`}
            </Text>

            {/* Своя подсказка вместо нативной (та осталась прозрачной ради TalkBack):
                Android рисует hint без lineHeight, и «Сообщение» вставало выше
                строки текста. Здесь метрика та же, что у первой строки инпута. */}
            {value.length === 0 ? (
              <Text pointerEvents="none" numberOfLines={1} style={styles.inputPlaceholder}>
                {placeholder}
              </Text>
            ) : null}

            {/* Инпут всегда с showSoftInputOnFocus: тап по сфокусированному полю
                при открытой панели сам поднимает IME, keyboardWillShow в хуке дока
                переводит режим в keyboard. Оверлеи и переключение флага не нужны. */}
            <TextInput
              ref={inputRef}
              nativeID="chat-compose-input"
              style={inputStyle}
              placeholder={placeholder}
              placeholderTextColor="transparent"
              value={value}
              onChangeText={handleChangeText}
              onSelectionChange={onSelectionChange}
              editable={!disabled}
              multiline
              maxLength={4000}
              /* Android не кладёт lineHeight на пустую строку, поэтому контент
                 короче своей коробки ровно на пустом инпуте и на пустой
                 последней строке — а выравнивание решает, куда уйдёт этот
                 остаток. Пустой инпут: по центру каретка стоит там же, куда
                 встанет первый символ со спаном (иначе он «приезжал» на 2px
                 ниже). С текстом: только по верху — там инпут ростом в потолок,
                 и центрирование увело бы строки на середину этой высоты. */
              textAlignVertical={isEmpty ? "center" : "top"}
              textBreakStrategy="simple"
              onFocus={handleInputFocus}
            />
          </Animated.View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={emojiChrome ? "Показать клавиатуру" : "Стикеры и эмодзи"}
            accessibilityState={{ expanded: emojiChrome }}
            style={({ pressed }) => [styles.chromeBtn, pressed && styles.chromeBtnPressed]}
            onPress={handleEmojiPress}
            disabled={disabled}
          >
            <Ionicons
              name={emojiChrome ? "keypad-outline" : "happy-outline"}
              size={20}
              color={floraColors.gray}
            />
          </Pressable>

          {canSendText ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Отправить"
              style={({ pressed }) => [styles.chromeBtn, pressed && styles.chromeBtnPressed]}
              onPress={() => onSend(value)}
              disabled={!canSendText}
            >
              {sending ? (
                <ActivityIndicator color={floraColors.greenLight} size="small" />
              ) : (
                <Ionicons name="send" size={18} color={floraColors.greenLight} />
              )}
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Голосовое сообщение"
              style={({ pressed }) => [styles.chromeBtn, pressed && styles.chromeBtnPressed]}
              disabled={!canStartVoice}
              onPress={onStartVoice}
            >
              <Ionicons
                name="mic-outline"
                size={20}
                color={canStartVoice ? floraColors.greenLight : floraColors.gray}
              />
            </Pressable>
          )}
        </View>

        {voiceMode ? (
          <View style={styles.voiceOverlay}>
            <ChatVoiceComposeBar
              recording={voiceRecording}
              showStopControl={voiceShowStopControl}
              recordingStartedAt={voiceRecordingStartedAt}
              waveform={voiceWaveform}
              transcoding={voiceTranscoding}
              onDiscard={() => onDiscardVoice?.()}
              onStop={() => onStopVoice?.()}
              onSend={() => onSendVoice?.()}
              sending={sending}
              canSend={voiceCanSend}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
});

/**
 * Одна типографика на инпут, зеркало строк и подсказку: расхождение шрифта или
 * межбуквенного сдвинуло бы переносы, и зеркало насчитало бы не те строки.
 */
const composeInputTypography = {
  fontSize: 15,
  fontWeight: "300",
  letterSpacing: 0.45,
  lineHeight: floraMessages.composeInputLineHeight,
  includeFontPadding: false,
} as const;

const styles = StyleSheet.create({
  shell: {
    paddingHorizontal: floraSpacing.grid,
    paddingTop: floraMessages.composeShellPaddingTop,
    borderTopWidth: 1,
    borderTopColor: floraMessages.divider,
    backgroundColor: floraColors.bg,
  },
  field: {
    flexDirection: "row",
    // Кнопки стоят у нижней грани и на многострочном поле (паритет
    // .messagesComposeRow): по центру они всплывали бы вместе с ростом.
    alignItems: "flex-end",
    gap: floraMessages.composeFieldGap,
    borderWidth: 1,
    borderColor: floraMessages.composeBorderColor,
    borderRadius: floraMessages.composeRadius,
    paddingHorizontal: floraMessages.composeFieldPaddingHorizontal,
    paddingVertical: floraMessages.composeFieldPaddingVertical,
    minHeight: floraMessages.composeFieldMinHeight,
  },
  /** Стек «поле + voice-оверлей»: оба слоя одной геометрии pill. */
  fieldZone: {
    position: "relative",
  },
  /**
   * Voice-режим: поле полностью сохраняет layout и фокус (только прозрачное).
   * Любые манипуляции с размером/клипом сфокусированного TextInput на части
   * Android IME приводят к закрытию клавиатуры — поэтому только opacity.
   */
  fieldUnderVoice: {
    opacity: 0,
  },
  /** Оверлей voice-бара строго поверх поля; фон гасит просветы под pill. */
  voiceOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: "center",
    backgroundColor: floraColors.bg,
  },
  chromeBtn: {
    width: floraMessages.composeChromeBtn,
    height: floraMessages.composeChromeBtn,
    marginBottom: floraMessages.composeChromeBtnBottomInset,
    alignItems: "center",
    justifyContent: "center",
  },
  chromeBtnPressed: {
    opacity: 0.72,
  },
  /**
   * Высота зоны текста = строки × 22 + 2×10.5, поэтому зазор до краёв pill
   * одинаков на любом числе строк, и она же — единственное, что анимируется.
   * Клип обязателен: на росте новая строка ещё не помещается в коробку, на
   * сжатии — уходящая; и он же держит невидимое зеркало строк.
   */
  inputWrap: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
  },
  /**
   * Инпут прижат к ВЕРХУ зоны: коробка зоны растёт вниз-от-верхней-грани, а
   * сама верхняя грань едет вверх — так уже набранный текст едет вместе с ней,
   * ни одна строка не режется на месте. Высота инпута при этом постоянна (см.
   * inputStyle), сам он не двигается внутри зоны: его положение — это положение
   * зоны, поэтому текст физически не может разъехаться с коробкой.
   */
  input: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    color: floraColors.whiteTemplate,
    ...composeInputTypography,
    paddingHorizontal: 0,
    paddingTop: floraMessages.composeInputPaddingVertical,
    paddingBottom: floraMessages.composeInputPaddingVertical,
  },
  inputMirror: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    opacity: 0,
    ...composeInputTypography,
  },
  /** По верхней грани — как инпут: на сжатии до пустого поля едет вместе с ним. */
  inputPlaceholder: {
    position: "absolute",
    left: 0,
    right: 0,
    top: floraMessages.composeInputPaddingVertical,
    color: floraColors.gray,
    ...composeInputTypography,
  },
});

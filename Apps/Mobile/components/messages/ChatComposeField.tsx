import { Ionicons } from "@expo/vector-icons";
import { forwardRef, useCallback, useImperativeHandle, useRef } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type TextInputSelectionChangeEvent,
} from "react-native";
import { KeyboardController } from "react-native-keyboard-controller";
import { ChatComposeImageStrip } from "@/components/messages/ChatComposeImageStrip";
import { ChatVoiceComposeBar } from "@/components/messages/ChatVoiceComposeBar";
import type { DraftMessageImage } from "@/lib/useMessageComposeImages";
import { floraColors, floraMessages, floraSpacing } from "@/lib/theme";

export type ChatComposeFieldHandle = {
  insertToken: (token: string) => void;
  focusInput: () => void;
  blurInput: () => void;
  /**
   * Поднять IME. После dismiss({keepFocus}) инпут остаётся сфокусированным,
   * и JS focus() — no-op; setFocusTo("current") форсит показ клавиатуры нативно.
   */
  showInputKeyboard: () => void;
};

type Props = {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
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
  onShellLayout?: (height: number) => void;
  onInputFocus?: () => void;
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
    value,
    onChangeText,
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
    onInputFocus,
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
  const valueRef = useRef(value);
  valueRef.current = value;
  const selectionRef = useRef({ start: value.length, end: value.length });
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

  const insertToken = useCallback(
    (token: string) => {
      const current = valueRef.current;
      const start = Math.min(selectionRef.current.start, current.length);
      const end = Math.min(selectionRef.current.end, current.length);
      const next = current.slice(0, start) + token + current.slice(end);
      const caret = start + token.length;
      onChangeText(next);
      selectionRef.current = { start: caret, end: caret };
      requestAnimationFrame(() => {
        inputRef.current?.setNativeProps({ selection: { start: caret, end: caret } });
      });
    },
    [onChangeText],
  );

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
    }),
    [insertToken, showInputKeyboard],
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

  const reportShellLayout = useCallback(
    (event: { nativeEvent: { layout: { height: number } } }) => {
      onShellLayout?.(event.nativeEvent.layout.height);
    },
    [onShellLayout],
  );

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

          <View style={styles.inputWrap}>
            {/* Инпут всегда с showSoftInputOnFocus: тап по сфокусированному полю
                при открытой панели сам поднимает IME, keyboardWillShow в хуке дока
                переводит режим в keyboard. Оверлеи и переключение флага не нужны. */}
            <TextInput
              ref={inputRef}
              nativeID="chat-compose-input"
              style={styles.input}
              placeholder={placeholder}
              placeholderTextColor={floraColors.gray}
              value={value}
              onChangeText={onChangeText}
              onSelectionChange={onSelectionChange}
              editable={!disabled}
              multiline
              maxLength={4000}
              textAlignVertical="center"
              onFocus={handleInputFocus}
            />
          </View>

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
              onPress={onSend}
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
    alignItems: "center",
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
    alignItems: "center",
    justifyContent: "center",
  },
  chromeBtnPressed: {
    opacity: 0.72,
  },
  inputWrap: {
    flex: 1,
    minWidth: 0,
    maxHeight: floraSpacing.grid * 10,
    justifyContent: "center",
    alignSelf: "stretch",
  },
  input: {
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
    lineHeight: 22,
    paddingVertical: 0,
    paddingTop: 0,
    paddingBottom: 0,
    minHeight: 22,
    maxHeight: floraSpacing.grid * 10,
    includeFontPadding: false,
  },
});

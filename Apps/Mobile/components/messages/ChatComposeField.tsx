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
import { ChatComposeImageStrip } from "@/components/messages/ChatComposeImageStrip";
import { ChatVoiceComposeBar } from "@/components/messages/ChatVoiceComposeBar";
import type { DraftMessageImage } from "@/lib/useMessageComposeImages";
import { floraColors, floraMessages, floraSpacing } from "@/lib/theme";

export type ChatComposeFieldHandle = {
  insertToken: (token: string) => void;
  focusInput: () => void;
};

type Props = {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  sending: boolean;
  disabled: boolean;
  placeholder?: string;
  bottomInset?: number;
  emojiOpen: boolean;
  onRequestEmoji: () => void;
  onRequestKeyboard: () => void;
  images?: DraftMessageImage[];
  onRemoveImageAt?: (index: number) => void;
  onPickImages?: () => void;
  hasPendingImages?: boolean;
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
    emojiOpen,
    onRequestEmoji,
    onRequestKeyboard,
    images = [],
    onRemoveImageAt,
    onPickImages,
    hasPendingImages = false,
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

  useImperativeHandle(
    ref,
    () => ({
      insertToken,
      focusInput: () => inputRef.current?.focus(),
    }),
    [insertToken],
  );

  const handleEmojiPress = useCallback(() => {
    if (disabled) return;
    if (voiceMode) {
      onDiscardVoice?.();
    }
    if (emojiOpen) {
      onRequestKeyboard();
    } else {
      onRequestEmoji();
    }
  }, [disabled, emojiOpen, onDiscardVoice, onRequestEmoji, onRequestKeyboard, voiceMode]);

  const handleInputPress = useCallback(() => {
    if (disabled || !emojiOpen) return;
    onRequestKeyboard();
  }, [disabled, emojiOpen, onRequestKeyboard]);

  if (voiceMode) {
    return (
      <View
        style={{
          paddingBottom: bottomInset + floraMessages.composeShellPaddingBottomExtra,
        }}
      >
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
    );
  }

  return (
    <View
      style={[
        styles.shell,
        {
          paddingBottom: bottomInset + floraMessages.composeShellPaddingBottomExtra,
        },
      ]}
    >
      {images.length > 0 && onRemoveImageAt ? (
        <ChatComposeImageStrip images={images} onRemoveAt={onRemoveImageAt} />
      ) : null}
      <View style={styles.field}>
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
          <TextInput
            ref={inputRef}
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
            showSoftInputOnFocus={!emojiOpen}
          />
          {emojiOpen ? (
            <Pressable
              style={styles.inputOverlay}
              onPress={handleInputPress}
              accessibilityRole="button"
              accessibilityLabel="Показать клавиатуру"
            />
          ) : null}
        </View>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={emojiOpen ? "Показать клавиатуру" : "Стикеры и эмодзи"}
          accessibilityState={{ expanded: emojiOpen }}
          style={({ pressed }) => [styles.chromeBtn, pressed && styles.chromeBtnPressed]}
          onPress={handleEmojiPress}
          disabled={disabled}
        >
          <Ionicons
            name={emojiOpen ? "happy" : "happy-outline"}
            size={20}
            color={emojiOpen ? floraColors.greenLight : floraColors.gray}
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
    position: "relative",
  },
  inputOverlay: {
    ...StyleSheet.absoluteFill,
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

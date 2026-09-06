import { liveGridStyles } from "@/lib/liveGridStyles";
import { Ionicons } from "@expo/vector-icons";
import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { DropdownMenuOverlay } from "@/components/DropdownMenuOverlay";
import { floraColors, floraSpacing } from "@/lib/theme";

type Props = {
  emojiOpen: boolean;
  canPublish: boolean;
  publishing: boolean;
  canSaveDraft: boolean;
  savingDraft: boolean;
  onToggleEmoji: () => void;
  onPickPhoto: () => void;
  onPickVideo: () => void;
  onClear: () => void;
  onSaveDraft: () => void;
  onPublish: () => void;
  showDraftActions?: boolean;
  showPublish?: boolean;
};

export function ComposeToolbar({
  emojiOpen,
  canPublish,
  publishing,
  canSaveDraft,
  savingDraft,
  onToggleEmoji,
  onPickPhoto,
  onPickVideo,
  onClear,
  onSaveDraft,
  onPublish,
  showDraftActions = true,
  showPublish = true,
}: Props) {
  const attachRef = useRef<View>(null);
  const [attachOpen, setAttachOpen] = useState(false);

  return (
    <View style={styles.root}>
      <View ref={attachRef} collapsable={false}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Прикрепить"
          style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
          onPress={() => setAttachOpen(true)}
        >
          <Ionicons name="attach-outline" size={24} color={floraColors.gray} />
        </Pressable>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={emojiOpen ? "Скрыть эмодзи" : "Эмодзи"}
        accessibilityState={{ expanded: emojiOpen }}
        style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
        onPress={onToggleEmoji}
      >
        <Ionicons
          name={emojiOpen ? "keypad-outline" : "happy-outline"}
          size={24}
          color={emojiOpen ? floraColors.greenLight : floraColors.gray}
        />
      </Pressable>

      <View style={styles.spacer} />

      {showDraftActions ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Сохранить черновик"
          disabled={!canSaveDraft || savingDraft}
          style={({ pressed }) => [
            styles.iconBtn,
            (!canSaveDraft || savingDraft) && styles.disabled,
            pressed && canSaveDraft && styles.pressed,
          ]}
          onPress={onSaveDraft}
        >
          {savingDraft ? (
            <ActivityIndicator color={floraColors.greenLight} size="small" />
          ) : (
            <Ionicons name="save-outline" size={22} color={floraColors.gray} />
          )}
        </Pressable>
      ) : null}

      {showDraftActions ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Очистить"
          style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
          onPress={onClear}
        >
          <Ionicons name="trash-outline" size={22} color={floraColors.gray} />
        </Pressable>
      ) : null}

      {showPublish ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Опубликовать"
          disabled={!canPublish}
          style={({ pressed }) => [
            styles.publishBtn,
            !canPublish && styles.disabled,
            pressed && canPublish && styles.pressed,
          ]}
          onPress={onPublish}
        >
          {publishing ? (
            <ActivityIndicator color={floraColors.greenLight} size="small" />
          ) : (
            <Text style={styles.publishText}>Опубликовать</Text>
          )}
        </Pressable>
      ) : null}

      <DropdownMenuOverlay
        open={attachOpen}
        onClose={() => setAttachOpen(false)}
        anchorRef={attachRef}
        placement="above"
        menuStyle={styles.attachMenu}
      >
        <Pressable
          accessibilityRole="menuitem"
          style={({ pressed }) => [styles.attachItem, pressed && styles.pressed]}
          onPress={() => {
            setAttachOpen(false);
            onPickPhoto();
          }}
        >
          <Ionicons name="image-outline" size={20} color={floraColors.greenLight} />
          <Text style={styles.attachLabel}>Фото</Text>
        </Pressable>
        <Pressable
          accessibilityRole="menuitem"
          style={({ pressed }) => [styles.attachItem, pressed && styles.pressed]}
          onPress={() => {
            setAttachOpen(false);
            onPickVideo();
          }}
        >
          <Ionicons name="videocam-outline" size={20} color={floraColors.greenLight} />
          <Text style={styles.attachLabel}>Видео</Text>
        </Pressable>
      </DropdownMenuOverlay>
    </View>
  );
}

const styles = liveGridStyles(() => StyleSheet.create({
  root: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    paddingHorizontal: floraSpacing.gridFine,
    paddingVertical: floraSpacing.gridFine,
  },
  iconBtn: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  spacer: {
    flex: 1,
  },
  publishBtn: {
    minHeight: 36,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(164, 209, 138, 0.14)",
    marginRight: floraSpacing.gridFine,
  },
  publishText: {
    color: floraColors.greenLight,
    fontSize: 14,
    fontWeight: "400",
    letterSpacing: 0.4,
  },
  disabled: {
    opacity: 0.4,
  },
  attachMenu: {
    minWidth: 160,
    borderRadius: 12,
    backgroundColor: floraColors.popoverInset,
    borderWidth: 1,
    borderColor: floraColors.popoverDivider,
    paddingVertical: 6,
    overflow: "hidden",
  },
  attachItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  attachLabel: {
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
  },
  pressed: {
    opacity: 0.72,
  },
}));

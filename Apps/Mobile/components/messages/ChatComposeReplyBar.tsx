import { liveGridStyles } from "@/lib/liveGridStyles";
import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { MessageReplyDraft } from "@/lib/messageReply";
import { useSPx } from "@/lib/FloraGridProvider";
import { floraColors, floraMessages, floraSpacing, kegl, sPx } from "@/lib/theme";

type Props = {
  reply: MessageReplyDraft;
  onDismiss: () => void;
  onLayout?: (height: number) => void;
};

export function ChatComposeReplyBar({ reply, onDismiss, onLayout }: Props) {
  const sp = useSPx();
  return (
    <View
      style={styles.strip}
      onLayout={(e) => onLayout?.(e.nativeEvent.layout.height)}
      accessibilityRole="summary"
    >
      <View style={styles.item}>
        <View style={styles.accent} />
        <View style={styles.textBlock}>
          <Text style={styles.author} numberOfLines={1}>
            {reply.authorDisplayName}
          </Text>
          <Text style={styles.preview} numberOfLines={2}>
            {reply.preview}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Отменить ответ"
          style={({ pressed }) => [styles.dismissBtn, pressed && styles.dismissBtnPressed]}
          onPress={onDismiss}
          hitSlop={sp(8)}
        >
          <Ionicons name="close" size={sp(20)} color={floraColors.gray} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = liveGridStyles(() => StyleSheet.create({
  strip: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: floraMessages.composeBorderColor,
    backgroundColor: floraColors.bg,
    paddingHorizontal: floraSpacing.grid,
    paddingVertical: floraSpacing.gridFine * 2,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.gridFine * 2,
    minWidth: 0,
  },
  accent: {
    width: sPx(3),
    alignSelf: "stretch",
    borderRadius: sPx(2),
    backgroundColor: floraColors.greenLight,
  },
  textBlock: {
    flex: 1,
    minWidth: 0,
    gap: sPx(2),
  },
  author: {
    fontSize: kegl(13),
    fontWeight: "500",
    color: floraColors.greenLight,
  },
  preview: {
    fontSize: kegl(13),
    color: floraColors.gray,
    lineHeight: sPx(18),
  },
  dismissBtn: {
    width: sPx(32),
    height: sPx(32),
    alignItems: "center",
    justifyContent: "center",
    borderRadius: sPx(16),
  },
  dismissBtnPressed: {
    backgroundColor: "rgba(250, 250, 250, 0.06)",
  },
}));

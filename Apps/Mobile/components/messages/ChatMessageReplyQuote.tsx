import { StyleSheet, Text, View } from "react-native";
import type { FscpMessageReplyRef } from "@flora/client-core/fscp";
import { floraColors, floraSpacing } from "@/lib/theme";

type Props = {
  reply: FscpMessageReplyRef;
  isFromMe: boolean;
};

export function ChatMessageReplyQuote({ reply, isFromMe }: Props) {
  return (
    <View
      style={[styles.root, isFromMe ? styles.rootMe : styles.rootThem]}
      accessibilityLabel={`Ответ на сообщение ${reply.authorDisplayName}`}
    >
      <View style={styles.accent} />
      <View style={styles.textBlock}>
        <Text style={styles.author} numberOfLines={1}>
          {reply.authorDisplayName}
        </Text>
        <Text style={styles.preview} numberOfLines={1}>
          {reply.preview}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    position: "relative",
    flexDirection: "row",
    alignItems: "stretch",
    marginBottom: floraSpacing.gridFine * 2,
    paddingVertical: floraSpacing.gridFine * 2,
    paddingRight: floraSpacing.gridFine * 2,
    paddingLeft: floraSpacing.gridFine * 3 + 3,
    borderRadius: 8,
    overflow: "hidden",
    minWidth: 0,
  },
  rootMe: {
    backgroundColor: "rgba(0, 0, 0, 0.14)",
  },
  rootThem: {
    backgroundColor: "rgba(0, 0, 0, 0.2)",
  },
  accent: {
    position: "absolute",
    left: floraSpacing.gridFine * 2,
    top: floraSpacing.gridFine * 2,
    bottom: floraSpacing.gridFine * 2,
    width: 3,
    borderRadius: 2,
    backgroundColor: floraColors.greenLight,
  },
  textBlock: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  author: {
    fontSize: 13,
    fontWeight: "500",
    letterSpacing: 0.26,
    color: floraColors.greenLight,
  },
  preview: {
    fontSize: 13,
    letterSpacing: 0.26,
    color: "rgba(242, 244, 246, 0.72)",
  },
});

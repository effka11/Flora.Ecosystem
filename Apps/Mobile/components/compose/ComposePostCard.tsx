import { formatAtHandle, profileDisplayName } from "@flora/client-core/display";
import type { RefObject } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { ComposeMediaPreview } from "@/components/compose/ComposeMediaPreview";
import { FloraAvatar } from "@/components/FloraAvatar";
import type { DraftPostImage, DraftPostVideo } from "@/lib/compose/useComposePostMedia";
import { floraColors, floraFeedPost, floraSpacing } from "@/lib/theme";

type Props = {
  displayName: string;
  username?: string | null;
  avatarUuid?: string | null;
  communityName?: string | null;
  seed?: string;
  showHandle: boolean;
  text: string;
  placeholder: string;
  maxLength: number;
  error?: string | null;
  images: DraftPostImage[];
  video: DraftPostVideo | null;
  inputRef: RefObject<TextInput | null>;
  onChangeText: (value: string) => void;
  onSelectionChange: (start: number, end: number) => void;
  onRemoveImage: (index: number) => void;
  onRemoveVideo: () => void;
};

export function ComposePostCard({
  displayName,
  username,
  avatarUuid,
  communityName,
  seed,
  showHandle,
  text,
  placeholder,
  maxLength,
  error,
  images,
  video,
  inputRef,
  onChangeText,
  onSelectionChange,
  onRemoveImage,
  onRemoveVideo,
}: Props) {
  const label = communityName
    ? communityName
    : profileDisplayName(displayName, username ?? "");

  return (
    <View style={styles.card}>
      <View style={styles.cardRow}>
        <View style={styles.avatarCell}>
          <FloraAvatar
            key={seed ?? avatarUuid ?? displayName}
            size={floraFeedPost.avatarSize}
            avatarUuid={avatarUuid}
            displayName={displayName}
            username={username ?? undefined}
            seed={seed}
            communityName={communityName ?? undefined}
          />
        </View>

        <View style={styles.contentColumn}>
          <View style={styles.headerBand}>
            <View style={styles.postMeta}>
              <View style={styles.postMetaLink}>
                <Text style={styles.author} numberOfLines={1} ellipsizeMode="tail">
                  {label}
                </Text>
                {showHandle && username ? (
                  <>
                    <View style={styles.postMetaGap} />
                    <Text style={styles.handle} numberOfLines={1} ellipsizeMode="tail">
                      {formatAtHandle(username)}
                    </Text>
                  </>
                ) : null}
              </View>
            </View>
          </View>

          <View style={styles.postBody}>
            <TextInput
              ref={inputRef}
              style={styles.input}
              placeholder={placeholder}
              placeholderTextColor={floraColors.gray}
              multiline
              value={text}
              onChangeText={onChangeText}
              onSelectionChange={(e) => {
                const { start, end } = e.nativeEvent.selection;
                onSelectionChange(start, end);
              }}
              maxLength={maxLength}
              textAlignVertical="top"
            />
            <ComposeMediaPreview
              images={images}
              video={video}
              onRemoveImage={onRemoveImage}
              onRemoveVideo={onRemoveVideo}
            />
            <Text style={styles.counter}>
              {text.length}/{maxLength}
            </Text>
            {error ? <Text style={styles.error}>{error}</Text> : null}
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    paddingHorizontal: floraSpacing.grid,
    paddingTop: floraFeedPost.paddingTop,
    paddingBottom: floraFeedPost.paddingBottom,
  },
  cardRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: floraFeedPost.columnGap,
  },
  avatarCell: {
    width: floraFeedPost.avatarSize,
    height: floraFeedPost.avatarSize,
    flexShrink: 0,
  },
  contentColumn: {
    flex: 1,
    minWidth: 0,
    marginLeft: floraFeedPost.contentNudgeX,
  },
  headerBand: {
    position: "relative",
    height: floraFeedPost.avatarSize,
    paddingTop: floraFeedPost.headerPaddingTop,
  },
  postMeta: {
    flex: 1,
    minWidth: 0,
  },
  postMetaLink: {
    flexDirection: "row",
    flexWrap: "nowrap",
    alignItems: "baseline",
    maxWidth: "100%",
  },
  postMetaGap: {
    width: floraSpacing.grid - 2,
    flexShrink: 0,
  },
  author: {
    color: floraColors.whiteTemplate,
    fontWeight: "300",
    fontSize: 15,
    letterSpacing: 0.45,
    lineHeight: 15,
    flexShrink: 1,
    transform: [{ translateY: floraFeedPost.nicknameNudgeY }],
  },
  handle: {
    color: floraColors.gray,
    fontWeight: "300",
    fontSize: 15,
    letterSpacing: 0.45,
    lineHeight: 15,
    flexShrink: 0,
    transform: [{ translateY: floraFeedPost.nicknameNudgeY }],
  },
  postBody: {
    // У Text в ленте line-box даёт воздух сверху; contentNudgeX (-5) его компенсирует.
    // У TextInput верх = начало глифа, поэтому отрицательный margin поднимает текст выше ленты.
    marginTop: 0,
  },
  input: {
    minHeight: 25.5 * 4,
    marginBottom: floraFeedPost.textMarginBottom,
    color: floraColors.grayLight,
    fontSize: 15,
    fontWeight: "300",
    lineHeight: 25.5,
    letterSpacing: 0.45,
    paddingTop: 0,
    paddingBottom: 0,
    paddingHorizontal: 0,
    includeFontPadding: false,
  },
  counter: {
    color: floraColors.gray,
    fontSize: 12,
    fontWeight: "300",
    textAlign: "right",
    marginTop: floraSpacing.gridFine,
  },
  error: {
    color: floraColors.error,
    fontSize: 14,
    fontWeight: "300",
    marginTop: floraSpacing.gridFine,
  },
});

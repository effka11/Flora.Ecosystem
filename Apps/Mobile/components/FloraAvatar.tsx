import {
  avatarImageUrl,
  communityInitials,
  profileInitials,
  resolveDefaultAvatarColor,
} from "@flora/client-core/display";
import { Image } from "expo-image";
import { Link, type Href } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { isLocalDecodedUri, useFrcImageUri } from "@/lib/frcImage";
import { floraColors } from "@/lib/theme";

export type FloraAvatarProps = {
  size?: number;
  avatarUuid?: string | null;
  /** Локальный превью (черновик до сохранения) — приоритетнее avatarUuid. */
  previewUri?: string | null;
  displayName: string;
  username?: string;
  seed?: string;
  cacheVersion?: number;
  communityName?: string;
  href?: Href;
  style?: ViewStyle;
  onPress?: () => void;
};

type DefaultAvatarArtProps = {
  size: number;
  initials: string;
  backgroundColor: string;
};

function DefaultAvatarArt({ size, initials, backgroundColor }: DefaultAvatarArtProps) {
  return (
    <View style={[styles.defaultArt, { width: size, height: size, borderRadius: size / 2, backgroundColor }]}>
      <Text style={[styles.initials, { fontSize: Math.max(12, Math.round(size * 0.36)) }]}>{initials}</Text>
    </View>
  );
}

export function FloraAvatar({
  size = 45,
  avatarUuid,
  previewUri,
  displayName,
  username = "",
  seed,
  cacheVersion = 0,
  communityName,
  href,
  style,
  onPress,
}: FloraAvatarProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const trimmedPreview = previewUri?.trim() ?? "";
  const trimmedUuid = avatarUuid?.trim() ?? "";
  const showPreview = trimmedPreview.length > 0 && !imageFailed;
  const showRemote = !showPreview && trimmedUuid.length > 0 && !imageFailed;
  const colorSeed = seed?.trim() || username.trim() || displayName.trim();
  const initials = communityName ? communityInitials(communityName) : profileInitials(displayName, username);
  const backgroundColor = resolveDefaultAvatarColor(colorSeed);

  useEffect(() => {
    setImageFailed(false);
  }, [trimmedPreview, trimmedUuid]);
  const imageUri = useMemo(() => {
    if (showPreview) return trimmedPreview;
    if (!showRemote) return null;
    const base = avatarImageUrl(trimmedUuid);
    // avatarImageUrl already has `?fmt=fri`; bust with `&v=`.
    return cacheVersion > 0 ? `${base}&v=${cacheVersion}` : base;
  }, [cacheVersion, showPreview, showRemote, trimmedPreview, trimmedUuid]);
  // Avatars live outside feed viewability scopes; force decode or FRI never resolves.
  // Decode at the actual rendered size (a 45px circle never needs a 2048px PNG)
  // and on the dedicated avatar lane so a burst of avatars can't queue ahead
  // of post images. Local draft previews skip FRI decode.
  const resolvedImageUri = useFrcImageUri(showPreview ? "" : (imageUri ?? ""), {
    force: true,
    displayWidth: size,
    lane: "avatar",
  });
  const displayUri = showPreview ? trimmedPreview : resolvedImageUri;

  const content = imageUri && displayUri ? (
    <Image
      source={{ uri: displayUri }}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      contentFit="cover"
      cachePolicy={isLocalDecodedUri(displayUri) || showPreview ? "memory" : "memory-disk"}
      recyclingKey={displayUri}
      transition={0}
      onError={() => setImageFailed(true)}
    />
  ) : (
    <DefaultAvatarArt size={size} initials={initials} backgroundColor={backgroundColor} />
  );

  const wrapStyle = [{ width: size, height: size }, style];

  if (href) {
    return (
      <Link href={href} asChild>
        <Pressable style={({ pressed }) => [wrapStyle, pressed && styles.pressed]}>{content}</Pressable>
      </Link>
    );
  }

  if (onPress) {
    return (
      <Pressable style={({ pressed }) => [wrapStyle, pressed && styles.pressed]} onPress={onPress}>
        {content}
      </Pressable>
    );
  }

  return <View style={wrapStyle}>{content}</View>;
}

const styles = StyleSheet.create({
  defaultArt: {
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
  },
  initials: {
    color: floraColors.greenLight,
    fontWeight: "300",
    letterSpacing: 0.48,
  },
  pressed: {
    opacity: 0.72,
  },
});

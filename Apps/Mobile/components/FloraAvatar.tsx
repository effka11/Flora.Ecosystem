import {
  avatarImageUrl,
  communityInitials,
  profileInitials,
  resolveDefaultAvatarColor,
} from "@flora/client-core/display";
import { Image } from "expo-image";
import { Link, type Href } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { floraColors } from "@/lib/theme";

export type FloraAvatarProps = {
  size?: number;
  avatarUuid?: string | null;
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
  const trimmedUuid = avatarUuid?.trim() ?? "";
  const showImage = trimmedUuid.length > 0 && !imageFailed;
  const colorSeed = seed?.trim() || username.trim() || displayName.trim();
  const initials = communityName ? communityInitials(communityName) : profileInitials(displayName, username);
  const backgroundColor = resolveDefaultAvatarColor(colorSeed);
  const imageUri = useMemo(() => {
    if (!showImage) return null;
    const base = avatarImageUrl(trimmedUuid);
    return cacheVersion > 0 ? `${base}?v=${cacheVersion}` : base;
  }, [cacheVersion, showImage, trimmedUuid]);

  const content = showImage && imageUri ? (
    <Image
      source={{ uri: imageUri }}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      contentFit="cover"
      cachePolicy="disk"
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

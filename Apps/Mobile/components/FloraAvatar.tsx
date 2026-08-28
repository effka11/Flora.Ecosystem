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

/** Strike colour for blocked people — static, never animated. */
const ACCOUNT_BLOCKED_DIAGONAL = "#e8382c";

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
  /** People only. Communities (`communityName`) never get the strike. */
  accountBlocked?: boolean;
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

/** Static red diameter. Transform is set once — not driven per-frame. */
function BlockedAccountDiagonal({ size }: { size: number }) {
  const stroke = Math.max(2, Math.round(size * 0.055));
  const length = size * Math.SQRT2;
  return (
    <View
      pointerEvents="none"
      style={[styles.blockedOverlay, { width: size, height: size, borderRadius: size / 2 }]}
    >
      <View
        style={{
          position: "absolute",
          width: length,
          height: stroke,
          backgroundColor: ACCOUNT_BLOCKED_DIAGONAL,
          top: (size - stroke) / 2,
          left: (size - length) / 2,
          transform: [{ rotate: "45deg" }],
        }}
      />
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
  accountBlocked = false,
}: FloraAvatarProps) {
  const personBlocked = accountBlocked && !communityName;
  const [imageFailed, setImageFailed] = useState(false);
  const trimmedPreview = personBlocked ? "" : (previewUri?.trim() ?? "");
  const trimmedUuid = personBlocked ? "" : (avatarUuid?.trim() ?? "");
  const colorSeed = seed?.trim() || username.trim() || displayName.trim();
  const initials = communityName ? communityInitials(communityName) : profileInitials(displayName, username);
  const backgroundColor = resolveDefaultAvatarColor(colorSeed);

  const remoteUri = useMemo(() => {
    if (!trimmedUuid) return "";
    const base = avatarImageUrl(trimmedUuid);
    // avatarImageUrl already has `?fmt=fri`; bust with `&v=`.
    return cacheVersion > 0 ? `${base}&v=${cacheVersion}` : base;
  }, [cacheVersion, trimmedUuid]);
  // Avatars live outside feed viewability scopes; force decode or FRI never resolves.
  // Decode at the actual rendered size (a 45px circle never needs a 2048px PNG)
  // and on the dedicated avatar lane so a burst of avatars can't queue ahead
  // of post images. Local draft previews skip FRI decode.
  // Keep decoding even after onError: a missing cache file must not unmount
  // the FRI subscription, or the avatar stays on initials forever.
  const resolvedImageUri = useFrcImageUri(trimmedPreview ? "" : remoteUri, {
    force: true,
    displayWidth: size,
    lane: "avatar",
  });
  const displayUri = trimmedPreview || resolvedImageUri;

  useEffect(() => {
    setImageFailed(false);
  }, [trimmedPreview, trimmedUuid, resolvedImageUri]);

  const content = displayUri && !imageFailed ? (
    <Image
      source={{ uri: displayUri }}
      style={{ width: size, height: size, borderRadius: size / 2 }}
      contentFit="cover"
      cachePolicy={isLocalDecodedUri(displayUri) || Boolean(trimmedPreview) ? "memory" : "memory-disk"}
      recyclingKey={displayUri}
      transition={0}
      onError={() => setImageFailed(true)}
    />
  ) : (
    <DefaultAvatarArt size={size} initials={initials} backgroundColor={backgroundColor} />
  );

  const inner = (
    <>
      {content}
      {personBlocked ? <BlockedAccountDiagonal size={size} /> : null}
    </>
  );

  const wrapStyle = [{ width: size, height: size }, style];

  if (href) {
    return (
      <Link href={href} asChild>
        <Pressable style={({ pressed }) => [wrapStyle, pressed && styles.pressed]}>{inner}</Pressable>
      </Link>
    );
  }

  if (onPress) {
    return (
      <Pressable style={({ pressed }) => [wrapStyle, pressed && styles.pressed]} onPress={onPress}>
        {inner}
      </Pressable>
    );
  }

  return <View style={wrapStyle}>{inner}</View>;
}

const styles = StyleSheet.create({
  defaultArt: {
    alignItems: "center",
    justifyContent: "center",
    // Web `.defaultArt` inset ring — fill is `--flora-green-dark`, same as the profile cover.
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.08)",
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
  blockedOverlay: {
    position: "absolute",
    left: 0,
    top: 0,
    overflow: "hidden",
  },
});

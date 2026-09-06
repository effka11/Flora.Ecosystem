import { liveGridStyles } from "@/lib/liveGridStyles";
import { Image } from "expo-image";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { BackHandler, Pressable, StyleSheet, View } from "react-native";
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { isLocalDecodedUri, useFrcImageUri } from "@/lib/frcImage";
import { floraMotion, floraSpacing } from "@/lib/theme";

type FeedLightboxApi = {
  open: (uri: string) => void;
  close: () => void;
};

const FeedLightboxContext = createContext<FeedLightboxApi | null>(null);

const LIGHTBOX_FADE_MS = Math.round(floraMotion.baseMs * 2);
const IMAGE_RADIUS = () => floraSpacing.gridFine;

/**
 * Lightbox must decode FRI → PNG the same way as thumbnails (raw FRI is not
 * Image-readable). No `displayWidth`: the overlay shows the image at up to full
 * screen size (`contentFit="contain"`), the top rung of the cache ladder.
 */
function LightboxFrcImage({ uri }: { uri: string }) {
  const resolvedUri = useFrcImageUri(uri, { force: true });
  if (!resolvedUri) return null;
  return (
    <View style={[styles.clip, { borderRadius: IMAGE_RADIUS() }]}>
      <Image
        source={{ uri: resolvedUri }}
        style={[styles.image, { borderRadius: IMAGE_RADIUS() }]}
        contentFit="contain"
        cachePolicy={isLocalDecodedUri(resolvedUri) ? "memory" : "memory-disk"}
        recyclingKey={resolvedUri}
        transition={0}
      />
    </View>
  );
}

function FeedLightboxLayer({ uri, onClose }: { uri: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const opacity = useSharedValue(0);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  useEffect(() => {
    opacity.value = 0;
    opacity.value = withTiming(1, { duration: LIGHTBOX_FADE_MS });
  }, [opacity, uri]);

  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  return (
    <Reanimated.View
      pointerEvents="auto"
      style={[styles.layer, style]}
      accessibilityViewIsModal
    >
      <Pressable
        style={[
          styles.backdrop,
          { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 },
        ]}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Закрыть фото"
      >
        <Pressable style={styles.content} onPress={onClose}>
          <LightboxFrcImage uri={uri} />
        </Pressable>
      </Pressable>
    </Reanimated.View>
  );
}

export function FeedLightboxProvider({ children }: { children: ReactNode }) {
  const [uri, setUri] = useState<string | null>(null);
  const open = useCallback((next: string) => setUri(next), []);
  const close = useCallback(() => setUri(null), []);
  const value = useMemo(() => ({ open, close }), [close, open]);
  return (
    <FeedLightboxContext.Provider value={value}>
      <View style={styles.providerRoot}>
        {children}
        {uri ? <FeedLightboxLayer uri={uri} onClose={close} /> : null}
      </View>
    </FeedLightboxContext.Provider>
  );
}

export function useFeedLightbox(): FeedLightboxApi | null {
  return useContext(FeedLightboxContext);
}

const styles = liveGridStyles(() => StyleSheet.create({
  providerRoot: {
    flex: 1,
  },
  layer: {
    ...StyleSheet.absoluteFill,
    zIndex: 2000,
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.85)",
    paddingHorizontal: 16,
    justifyContent: "center",
    alignItems: "center",
  },
  content: {
    width: "100%",
    height: "100%",
    justifyContent: "center",
    alignItems: "center",
  },
  clip: {
    width: "100%",
    height: "100%",
    overflow: "hidden",
  },
  image: {
    width: "100%",
    height: "100%",
  },
}));

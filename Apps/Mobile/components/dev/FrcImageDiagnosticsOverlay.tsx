import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  getFrcImageDiagnostics,
  type FrcImageDiagnostics,
} from "@/lib/frcImage";
import {
  floraColors,
  floraSpacing,
  floraTabBarContentHeight,
} from "@/lib/theme";

const POLL_MS = 500;

function avgMs(totalMs: number, samples: number): string {
  if (samples <= 0) return "—";
  return `${Math.round(totalMs / samples)}`;
}

function peekHitPct(hits: number, misses: number): string {
  const total = hits + misses;
  if (total <= 0) return "—";
  return `${Math.round((hits / total) * 100)}%`;
}

function cacheMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)}`;
}

function FrcImageDiagnosticsOverlayDev() {
  const insets = useSafeAreaInsets();
  const [expanded, setExpanded] = useState(false);
  const [stats, setStats] = useState<FrcImageDiagnostics | null>(null);

  useEffect(() => {
    const tick = () => setStats(getFrcImageDiagnostics());
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, []);

  if (!stats) return null;

  const blankedBad = stats.blanked > 0;
  const bottom = floraTabBarContentHeight() + Math.max(insets.bottom, 8) + floraSpacing.grid;

  if (!expanded) {
    return (
      <View
        pointerEvents="box-none"
        style={[styles.host, { bottom, right: floraSpacing.grid }]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="FRC diag"
          onPress={() => setExpanded(true)}
          style={[styles.badge, blankedBad && styles.badgeAlert]}
        >
          <Text style={[styles.badgeText, blankedBad && styles.alertText]}>
            FRI blanked {stats.blanked}
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View
      pointerEvents="box-none"
      style={[styles.host, { bottom, right: floraSpacing.grid }]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Свернуть FRC diag"
        onPress={() => setExpanded(false)}
        style={styles.panel}
      >
        <Text style={styles.title}>FRI diag</Text>

        <Text style={[styles.row, blankedBad && styles.alertText]}>
          blanked {stats.blanked}
        </Text>
        <Text style={styles.row}>
          1st paint {avgMs(stats.firstPaintTotalMs, stats.firstPaintSamples)} ms
          {" · "}
          n={stats.firstPaintSamples}
        </Text>
        <Text style={styles.row}>
          peek {peekHitPct(stats.peekHits, stats.peekMisses)}
          {" · "}
          {stats.peekHits}/{stats.peekHits + stats.peekMisses}
        </Text>
        <Text style={styles.row}>
          resolve {avgMs(stats.decodeMs, stats.completed)} ms
          {" · "}
          ok {stats.completed} / fail {stats.failed}
        </Text>
        <Text style={styles.row}>
          q {stats.queued} · run {stats.running} · sub {stats.subscribers}
          {" · "}
          {stats.paused ? "paused" : "live"}
        </Text>
        <Text style={styles.row}>
          cache {stats.cacheEntries} · {cacheMb(stats.cacheBytes)} MB
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * Dev-only overlay over `getFrcImageDiagnostics()`.
 * Production builds return null before any poll/effect runs.
 */
export function FrcImageDiagnosticsOverlay() {
  if (!__DEV__) return null;
  return <FrcImageDiagnosticsOverlayDev />;
}

const styles = StyleSheet.create({
  host: {
    position: "absolute",
    zIndex: 50,
    maxWidth: 220,
  },
  badge: {
    backgroundColor: "rgba(18, 18, 18, 0.72)",
    borderColor: "rgba(250, 250, 250, 0.16)",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  badgeAlert: {
    borderColor: "rgba(255, 90, 90, 0.7)",
    backgroundColor: "rgba(80, 16, 16, 0.82)",
  },
  badgeText: {
    color: floraColors.gray,
    fontSize: 11,
    fontWeight: "500",
    letterSpacing: 0.2,
  },
  panel: {
    backgroundColor: "rgba(18, 18, 18, 0.82)",
    borderColor: "rgba(250, 250, 250, 0.16)",
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 3,
  },
  title: {
    color: floraColors.greenLight,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.3,
    marginBottom: 2,
  },
  row: {
    color: floraColors.grayLight,
    fontSize: 11,
    fontWeight: "400",
    letterSpacing: 0.15,
    lineHeight: 14,
  },
  alertText: {
    color: "#ff6b6b",
    fontWeight: "700",
  },
});

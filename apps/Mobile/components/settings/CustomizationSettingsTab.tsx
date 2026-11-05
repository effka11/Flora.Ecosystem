import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { settingsUi as ui } from "@/components/settings/settingsUi";
import { useSPx } from "@/lib/FloraGridProvider";
import { useFloraTheme } from "@/lib/FloraThemeProvider";
import { liveGridStyles } from "@/lib/liveGridStyles";
import {
  FLORA_THEME_IDS,
  FLORA_THEMES,
  floraTokenAlpha,
  type FloraThemeId,
  type FloraThemeTokens,
} from "@/lib/floraTheme";
import { floraColors, floraSpacing, kegl, sPx, tracking } from "@/lib/theme";
import { useThemeStore } from "@/stores/themeStore";

function normalizeSearch(value: string): string {
  return value.trim().toLowerCase();
}

function matchesSearch(query: string, ...haystacks: readonly (string | null | undefined)[]): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  return haystacks.some((item) => (item ?? "").toLowerCase().includes(q));
}

type Props = {
  searchQuery: string;
};

function ThemePreview({ palette }: { palette: FloraThemeTokens }) {
  const line = floraTokenAlpha(palette.whiteTemplate, 0.1);
  const border = floraTokenAlpha(palette.whiteTemplate, 0.1);
  return (
    <View
      style={[
        styles.preview,
        {
          backgroundColor: palette.bg,
          borderColor: floraTokenAlpha(palette.whiteTemplate, 0.08),
        },
      ]}
    >
      <View style={[styles.previewSidebar, { backgroundColor: palette.reserveSurfaceThem, borderColor: border }]}>
        <View style={[styles.previewLine, { backgroundColor: line }]} />
        <View style={[styles.previewLine, styles.previewLineShort, { backgroundColor: line }]} />
      </View>
      <View style={styles.previewMain}>
        <View style={[styles.previewBubble, { backgroundColor: palette.reserveSubstrateGrayMuted }]} />
        <View style={[styles.previewBubble, styles.previewBubbleRight, { backgroundColor: palette.greenDark }]} />
        <View
          style={[
            styles.previewBubble,
            styles.previewBubbleShort,
            { backgroundColor: palette.reserveSubstrateGrayMuted },
          ]}
        />
      </View>
    </View>
  );
}

function ThemeOption({
  themeId,
  selected,
  onSelect,
}: {
  themeId: FloraThemeId;
  selected: boolean;
  onSelect: (themeId: FloraThemeId) => void;
}) {
  const sp = useSPx();
  const theme = FLORA_THEMES[themeId];

  return (
    <Pressable
      testID={`theme-option-${themeId}`}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`Тема ${theme.label}`}
      android_ripple={null}
      onPress={() => onSelect(themeId)}
      style={[styles.card, selected && styles.cardSelected]}
    >
      <ThemePreview palette={theme.palette} />
      <View style={styles.cardInfo}>
        <Text style={styles.cardTitle}>{theme.label}</Text>
        <Text style={styles.cardDescription} numberOfLines={2}>
          {theme.description}
        </Text>
      </View>
      {/* Слот галочки постоянен: выбор темы не сужает текст и не меняет высоту карточки. */}
      <View style={[styles.checkSlot, { width: sp(20) }]}>
        {selected ? <Ionicons name="checkmark" size={sp(20)} color={floraColors.accent} /> : null}
      </View>
    </Pressable>
  );
}

export function CustomizationSettingsTab({ searchQuery }: Props) {
  // Рамка выбора — от уже применённой палитры, не от предпросмотра: на Android
  // она меняется под снимком и растворяется вместе с темой, без вспышки до него.
  const { themeId: appliedThemeId } = useFloraTheme();
  const selectTheme = useThemeStore((state) => state.selectTheme);
  const themeVisible = matchesSearch(
    searchQuery,
    "тема",
    "тёмная",
    "темная",
    "светлая",
    "flora",
    "старая",
    "оформление",
  );

  if (!themeVisible) return null;

  return (
    <View style={ui.tabBody}>
      <View style={ui.section}>
        <Text style={ui.sectionTitle}>Тема</Text>
        <View style={styles.options}>
          {FLORA_THEME_IDS.map((themeId) => (
            <ThemeOption
              key={themeId}
              themeId={themeId}
              selected={appliedThemeId === themeId}
              onSelect={selectTheme}
            />
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = liveGridStyles(() =>
  StyleSheet.create({
    options: {
      gap: floraSpacing.grid,
    },
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: floraSpacing.grid * 2,
      padding: floraSpacing.grid,
      borderRadius: sPx(12),
      borderWidth: 1,
      borderColor: floraColors.overlay(0.15),
      backgroundColor: floraColors.overlay(0.02),
    },
    cardSelected: {
      borderColor: floraColors.accent,
      backgroundColor: floraColors.overlay(0.06),
    },
    cardInfo: {
      flex: 1,
      minWidth: 0,
      // Три строки (заголовок + две строки описания) — высота карточки не зависит
      // от того, выбрана тема или нет.
      minHeight: floraSpacing.grid * 3 + floraSpacing.gridFine,
      gap: floraSpacing.gridFine,
    },
    // Высота слота галочки держится на `sp(20)` в рендере (runtime-шаг сетки).
    checkSlot: {
      alignItems: "center",
      justifyContent: "center",
    },
    cardTitle: {
      color: floraColors.text,
      fontSize: kegl(15),
      fontWeight: "400",
      letterSpacing: tracking(0.45),
      lineHeight: floraSpacing.grid,
    },
    cardDescription: {
      color: floraColors.gray,
      fontSize: kegl(12),
      fontWeight: "300",
      letterSpacing: tracking(0.3),
      lineHeight: floraSpacing.grid,
    },
    preview: {
      width: sPx(76),
      height: sPx(48),
      flexDirection: "row",
      borderRadius: sPx(6),
      borderWidth: 1,
      overflow: "hidden",
    },
    previewSidebar: {
      width: "30%",
      padding: sPx(4),
      gap: sPx(3),
      borderRightWidth: 1,
    },
    previewLine: {
      height: 2,
      borderRadius: 1,
    },
    previewLineShort: {
      width: "60%",
    },
    previewMain: {
      flex: 1,
      padding: sPx(4),
      gap: sPx(3),
    },
    previewBubble: {
      height: sPx(6),
      borderRadius: sPx(3),
    },
    previewBubbleRight: {
      alignSelf: "flex-end",
      width: "55%",
    },
    previewBubbleShort: {
      width: "40%",
    },
  }),
);

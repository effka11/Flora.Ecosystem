import { type ReactNode, useMemo } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { useDerivedValue, useSharedValue, type SharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FloraTabChipStrip } from "@/components/chrome/FloraTabChipStrip";
import { SearchSuggestionTags, type SearchSuggestionTag } from "@/components/SearchSuggestionTags";
import {
  TabScreenSearchHeader,
  type HeaderIconAction,
  type HeaderSaveAction,
  type TabScreenSearchHeaderProps,
} from "@/components/TabScreenSearchHeader";
import { TabScreenSearchSwap } from "@/components/TabScreenSearchSwap";
import { floraColors, floraSpacing } from "@/lib/theme";

export type { HeaderIconAction, HeaderSaveAction };

export type TabScreenHeaderIdleStrip = {
  stripOffset: SharedValue<number>;
  maxOffset: SharedValue<number>;
  viewportW: SharedValue<number>;
};

type IdleSlot = ReactNode | ((strip: TabScreenHeaderIdleStrip) => ReactNode);

type TabScreenHeaderProps = Omit<TabScreenSearchHeaderProps, "below"> & {
  idle?: IdleSlot;
  /** chips — полоса как в настройках; custom — дропдауны/папки, с pad title-row. */
  idleMode?: "chips" | "custom";
  searchTags?: readonly SearchSuggestionTag[];
  searchTagId?: string;
  onSearchTagIdChange?: (id: string) => void;
  extraBeforeSwap?: ReactNode;
  onLayout?: (event: LayoutChangeEvent) => void;
  /** Нижняя граница шелла. Настройки выключают — линия на полосе секций. */
  chromeBorder?: boolean;
  onChipPanBegin?: () => void;
  onChipPanFinalize?: (success: boolean) => void;
  onChipPanDecayEnd?: () => void;
};

export function TabScreenHeader({
  idle,
  idleMode,
  searchTags,
  searchTagId,
  onSearchTagIdChange,
  extraBeforeSwap,
  onLayout,
  chromeBorder = true,
  holdSearchFocusRef,
  onChipPanBegin,
  onChipPanFinalize,
  onChipPanDecayEnd,
  ...header
}: TabScreenHeaderProps) {
  const insets = useSafeAreaInsets();
  const stripOffset = useSharedValue(0);
  const stripViewportW = useSharedValue(0);
  const stripContentW = useSharedValue(0);
  const maxOffset = useDerivedValue(() =>
    Math.max(0, stripContentW.value - stripViewportW.value),
  );
  const strip = useMemo(
    () => ({ stripOffset, maxOffset, viewportW: stripViewportW }),
    [maxOffset, stripOffset, stripViewportW],
  );

  const mode = idleMode ?? (idle != null ? "chips" : "custom");
  const hasSwap = idle != null || searchTags != null;
  const idleNode = typeof idle === "function" ? idle(strip) : idle;

  return (
    <View
      style={[
        styles.shell,
        { paddingTop: insets.top + floraSpacing.grid },
        chromeBorder ? styles.shellBorder : null,
      ]}
      onLayout={onLayout}
    >
      <TabScreenSearchHeader
        {...header}
        holdSearchFocusRef={holdSearchFocusRef}
        below={
          extraBeforeSwap || hasSwap
            ? ({ progress, searchMounted }) => (
                <>
                  {extraBeforeSwap ? <View style={styles.extraPad}>{extraBeforeSwap}</View> : null}
                  {hasSwap ? (
                    <TabScreenSearchSwap
                      progress={progress}
                      searchMounted={searchMounted}
                      idle={
                        mode === "chips" ? (
                          <FloraTabChipStrip
                            offset={stripOffset}
                            maxOffset={maxOffset}
                            viewportW={stripViewportW}
                            contentW={stripContentW}
                            onPanBegin={onChipPanBegin}
                            onPanFinalize={onChipPanFinalize}
                            onPanDecayEnd={onChipPanDecayEnd}
                          >
                            {idleNode}
                          </FloraTabChipStrip>
                        ) : (
                          <View style={styles.customIdle}>{idleNode}</View>
                        )
                      }
                      search={
                        searchTags && searchTagId != null && onSearchTagIdChange ? (
                          <SearchSuggestionTags
                            tags={searchTags}
                            selectedId={searchTagId}
                            onSelectedIdChange={onSearchTagIdChange}
                            holdFocusRef={holdSearchFocusRef}
                          />
                        ) : (
                          <View />
                        )
                      }
                    />
                  ) : null}
                </>
              )
            : undefined
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    backgroundColor: floraColors.bg,
    paddingBottom: 0,
    gap: floraSpacing.gridFine,
  },
  shellBorder: {
    borderBottomColor: "rgba(250, 250, 250, 0.08)",
    borderBottomWidth: 1,
  },
  extraPad: {
    paddingHorizontal: floraSpacing.grid,
  },
  customIdle: {
    paddingHorizontal: floraSpacing.grid,
  },
});

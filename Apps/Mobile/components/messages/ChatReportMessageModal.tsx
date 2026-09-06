import { liveGridStyles } from "@/lib/liveGridStyles";
import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import type { FrankingReportCategory } from "@flora/client-core/contracts";
import { FRANKING_REPORT_CATEGORY_OPTIONS } from "@/lib/messageReport";
import { floraColors, floraSpacing } from "@/lib/theme";

type Props = {
  visible: boolean;
  busy?: boolean;
  error?: string | null;
  onDismiss: () => void;
  onConfirm: (category: FrankingReportCategory) => void;
};

/** Жалоба на сообщение 1:1 — визуально как SettingsConfirmModal, список на сетке 15/5. */
export function ChatReportMessageModal({
  visible,
  busy = false,
  error = null,
  onDismiss,
  onConfirm,
}: Props) {
  const [category, setCategory] = useState<FrankingReportCategory>("abuse");

  useEffect(() => {
    if (!visible) return;
    setCategory("abuse");
  }, [visible]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={busy ? undefined : onDismiss}
    >
      <View style={styles.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={busy ? undefined : onDismiss}
          accessibilityRole="button"
          accessibilityLabel="Закрыть"
        />
        <View style={styles.card} accessibilityViewIsModal>
          <View style={styles.iconWrap}>
            {busy ? (
              <ActivityIndicator color="#f6a8a8" />
            ) : (
              <Ionicons name="flag-outline" size={28} color="#f6a8a8" />
            )}
          </View>

          <Text style={styles.title}>Пожаловаться</Text>

          <View accessibilityRole="radiogroup" style={styles.categoryList}>
            {FRANKING_REPORT_CATEGORY_OPTIONS.map((option) => {
              const selected = category === option.value;
              return (
                <Pressable
                  key={option.value}
                  accessibilityRole="radio"
                  accessibilityState={{ selected, disabled: busy }}
                  accessibilityLabel={option.label}
                  disabled={busy}
                  style={({ pressed }) => [
                    styles.optionRow,
                    selected && styles.optionRowSelected,
                    pressed && !busy && styles.btnPressed,
                  ]}
                  onPress={() => setCategory(option.value)}
                >
                  <View style={styles.optionRadio}>
                    <Ionicons
                      name={selected ? "radio-button-on" : "radio-button-off"}
                      size={floraSpacing.grid}
                      color={selected ? floraColors.greenLight : floraColors.gray}
                    />
                  </View>
                  <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            style={({ pressed }) => [
              styles.confirmBtn,
              (pressed || busy) && styles.btnPressed,
              busy && styles.btnDisabled,
            ]}
            onPress={() => onConfirm(category)}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Отправить"
          >
            <Text style={styles.confirmBtnText}>{busy ? "Отправка…" : "Отправить"}</Text>
          </Pressable>

          <Pressable
            style={({ pressed }) => [styles.secondaryBtn, pressed && !busy && styles.btnPressed]}
            onPress={onDismiss}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Отмена"
          >
            <Text style={styles.secondaryBtnText}>Отмена</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = liveGridStyles(() => StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: floraSpacing.grid * 2,
  },
  card: {
    width: "100%",
    maxWidth: 320,
    borderRadius: floraSpacing.grid,
    backgroundColor: floraColors.surfaceElevated,
    borderWidth: 1,
    borderColor: floraColors.border,
    paddingHorizontal: floraSpacing.grid * 2,
    paddingTop: floraSpacing.grid * 2,
    paddingBottom: floraSpacing.grid * 2,
    alignItems: "center",
    gap: floraSpacing.grid,
  },
  iconWrap: {
    width: floraSpacing.grid * 3,
    height: floraSpacing.grid * 3,
    borderRadius: (floraSpacing.grid * 3) / 2,
    backgroundColor: "rgba(246, 168, 168, 0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    color: floraColors.whiteTemplate,
    fontSize: 17,
    fontWeight: "500",
    letterSpacing: 0.34,
    textAlign: "center",
    lineHeight: 22,
  },
  categoryList: {
    width: "100%",
    gap: floraSpacing.gridFine,
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
    minHeight: floraSpacing.grid * 3,
    paddingHorizontal: floraSpacing.grid,
    borderRadius: floraSpacing.grid,
  },
  optionRowSelected: {
    backgroundColor: "rgba(250, 250, 250, 0.06)",
  },
  optionRadio: {
    width: floraSpacing.grid,
    height: floraSpacing.grid,
    alignItems: "center",
    justifyContent: "center",
  },
  optionLabel: {
    flex: 1,
    color: "rgba(250, 250, 250, 0.9)",
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.42,
    lineHeight: 20,
  },
  optionLabelSelected: {
    color: floraColors.whiteTemplate,
    fontWeight: "400",
  },
  error: {
    color: "#f6a8a8",
    fontSize: 12,
    fontWeight: "300",
    textAlign: "center",
    lineHeight: floraSpacing.grid,
  },
  confirmBtn: {
    width: "100%",
    minHeight: floraSpacing.grid * 3,
    borderRadius: 9999,
    backgroundColor: "rgba(246, 168, 168, 0.18)",
    alignItems: "center",
    justifyContent: "center",
  },
  confirmBtnText: {
    color: "#f6a8a8",
    fontSize: 14,
    fontWeight: "400",
    letterSpacing: 0.42,
    lineHeight: floraSpacing.grid,
  },
  secondaryBtn: {
    width: "100%",
    minHeight: floraSpacing.grid * 3,
    borderRadius: 9999,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryBtnText: {
    color: floraColors.gray,
    fontSize: 14,
    fontWeight: "300",
    letterSpacing: 0.42,
    lineHeight: floraSpacing.grid,
  },
  btnPressed: {
    opacity: 0.85,
  },
  btnDisabled: {
    opacity: 0.7,
  },
}));

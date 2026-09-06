import { liveGridStyles } from "@/lib/liveGridStyles";
import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { settingsUi as ui } from "@/components/settings/settingsUi";
import { floraColors, floraSpacing } from "@/lib/theme";

type Option<T extends string> = {
  value: T;
  label: string;
};

type SettingsSelectFieldProps<T extends string> = {
  label: string;
  value: T;
  options: readonly Option<T>[];
  onChange: (value: T) => void;
};

/** Селект настроек: поле как input + модалка выбора по центру (паритет web `<select>`). */
export function SettingsSelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: SettingsSelectFieldProps<T>) {
  const [open, setOpen] = useState(false);
  const current = options.find((item) => item.value === value)?.label ?? value;

  return (
    <View style={ui.fieldGroup}>
      <Text style={ui.fieldLabel}>{label}</Text>
      <Pressable
        style={({ pressed }) => [styles.select, pressed && ui.pressed]}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={label}
      >
        <Text style={styles.selectValue} numberOfLines={1}>
          {current}
        </Text>
        <Ionicons name="chevron-down" size={18} color={floraColors.gray} />
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <View style={styles.backdrop}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen(false)} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{label}</Text>
            {options.map((option) => {
              const selected = option.value === value;
              return (
                <Pressable
                  key={option.value}
                  style={({ pressed }) => [styles.optionRow, pressed && ui.pressed]}
                  onPress={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <Text style={[styles.optionLabel, selected && styles.optionLabelSelected]}>
                    {option.label}
                  </Text>
                  {selected ? (
                    <Ionicons name="checkmark" size={20} color={floraColors.greenLight} />
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = liveGridStyles(() => StyleSheet.create({
  select: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.gridFine,
    backgroundColor: "transparent",
    borderColor: "rgba(250, 250, 250, 0.15)",
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: floraSpacing.grid,
    height: floraSpacing.grid * 3,
  },
  selectValue: {
    flex: 1,
    minWidth: 0,
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: floraSpacing.grid * 2,
  },
  sheet: {
    width: "100%",
    maxWidth: 320,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(250, 250, 250, 0.08)",
    backgroundColor: floraColors.surfaceElevated,
    paddingVertical: floraSpacing.gridFine,
    paddingHorizontal: floraSpacing.grid,
    gap: floraSpacing.gridFine,
    maxHeight: "70%",
  },
  sheetTitle: {
    color: floraColors.gray,
    fontSize: 13,
    fontWeight: "300",
    letterSpacing: 0.45,
    paddingHorizontal: floraSpacing.gridFine,
    paddingVertical: floraSpacing.gridFine * 2,
  },
  optionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: floraSpacing.grid,
    minHeight: floraSpacing.grid * 3,
    paddingHorizontal: floraSpacing.gridFine,
    paddingVertical: floraSpacing.gridFine,
  },
  optionLabel: {
    flex: 1,
    color: floraColors.whiteTemplate,
    fontSize: 15,
    fontWeight: "300",
    letterSpacing: 0.45,
  },
  optionLabelSelected: {
    color: floraColors.greenLight,
  },
}));

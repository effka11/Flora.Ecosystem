import { useMemo } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { settingsUi as ui } from "@/components/settings/settingsUi";
import {
  countryFlagEmoji,
  formatPhoneDraft,
  formatPhoneDraftFromInput,
  isPhoneInputAtRegionLimit,
  type PhoneDraft,
} from "@/lib/phoneNumber";
import { floraColors, floraSpacing } from "@/lib/theme";

type Props = {
  value: string;
  onChange: (next: PhoneDraft) => void;
  editable?: boolean;
  placeholder?: string;
  placeholderTextColor?: string;
};

/**
 * Поле телефона: as-you-type форматирование + флаг страны справа внутри инпута.
 * Лишние цифры региона не вводятся (maxLength на лимите).
 */
export function PhoneNumberField({
  value,
  onChange,
  editable = true,
  placeholder = "Не указан",
  placeholderTextColor = "rgba(250, 250, 250, 0.3)",
}: Props) {
  const flag = useMemo(() => {
    const country = formatPhoneDraft(value).country;
    return countryFlagEmoji(country);
  }, [value]);

  const atRegionLimit = useMemo(() => isPhoneInputAtRegionLimit(value), [value]);

  return (
    <View style={styles.wrap}>
      <TextInput
        style={[ui.input, styles.input]}
        value={value}
        onChangeText={(raw) => onChange(formatPhoneDraftFromInput(raw, value))}
        maxLength={atRegionLimit ? value.length : undefined}
        placeholder={placeholder}
        placeholderTextColor={placeholderTextColor}
        keyboardType="phone-pad"
        autoComplete="tel"
        textContentType="telephoneNumber"
        editable={editable}
      />
      {flag ? (
        <View style={styles.flagSlot} pointerEvents="none">
          <Text style={styles.flag} accessibilityLabel="Страна номера">
            {flag}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "relative",
    justifyContent: "center",
  },
  input: {
    paddingRight: floraSpacing.grid * 3,
  },
  flagSlot: {
    position: "absolute",
    right: floraSpacing.grid,
    top: 0,
    bottom: 0,
    width: floraSpacing.grid * 2,
    alignItems: "center",
    justifyContent: "center",
  },
  flag: {
    fontSize: 18,
    lineHeight: 22,
    color: floraColors.whiteTemplate,
  },
});

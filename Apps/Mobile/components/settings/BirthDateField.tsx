import { useEffect, useState } from "react";
import { Text, View } from "react-native";
// RNGH TextInput: при активации pager-pan получает ACTION_CANCEL — иначе
// EditText ведёт курсор и рисует лупу выделения весь горизонтальный свайп.
import { TextInput } from "react-native-gesture-handler";
import { settingsUi as ui } from "@/components/settings/settingsUi";
import {
  birthDateDigitsToIso,
  filterBirthDateDigits,
  formatBirthDateDigits,
  isBirthDateDigitsComplete,
  isoToBirthDateDigits,
} from "@/lib/birthDateMask";

type BirthDateFieldProps = {
  label?: string;
  value: string;
  onChange: (isoValue: string) => void;
};

/** Маска ДД.ММ.ГГГГ → ISO `yyyy-MM-dd`, как BirthDateInput на вебе. */
export function BirthDateField({ label = "Дата рождения", value, onChange }: BirthDateFieldProps) {
  const [digits, setDigits] = useState(() => isoToBirthDateDigits(value));
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) {
      setDigits(isoToBirthDateDigits(value));
    }
  }, [focused, value]);

  const displayValue = formatBirthDateDigits(digits);

  const commitDigits = (nextDigits: string, previousDigits: string) => {
    const normalized = filterBirthDateDigits(nextDigits, previousDigits);
    setDigits(normalized);

    if (!normalized.length) {
      onChange("");
      return;
    }
    if (!isBirthDateDigitsComplete(normalized)) return;
    const iso = birthDateDigitsToIso(normalized);
    onChange(iso ?? "");
  };

  return (
    <View style={ui.fieldGroup}>
      <Text style={ui.fieldLabel}>{label}</Text>
      <TextInput
        style={[ui.input, { fontVariant: ["tabular-nums"], letterSpacing: 0.6 }]}
        value={displayValue}
        onChangeText={(raw) => {
          const next = raw.replace(/\D/g, "").slice(0, 8);
          commitDigits(next, digits);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          if (!digits.length) {
            onChange("");
            return;
          }
          if (isBirthDateDigitsComplete(digits)) {
            const iso = birthDateDigitsToIso(digits);
            onChange(iso ?? "");
            if (!iso) setDigits("");
          }
        }}
        placeholder="__.__.____"
        placeholderTextColor="rgba(250, 250, 250, 0.3)"
        keyboardType="number-pad"
        autoCorrect={false}
        maxLength={10}
      />
    </View>
  );
}

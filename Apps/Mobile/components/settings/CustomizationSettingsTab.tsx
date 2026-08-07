import { Text, View } from "react-native";
import { settingsUi as ui } from "@/components/settings/settingsUi";

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

export function CustomizationSettingsTab({ searchQuery }: Props) {
  const themeVisible = matchesSearch(searchQuery, "тема", "тёмная", "темная", "оформление");
  const moreVisible = matchesSearch(
    searchQuery,
    "акцент",
    "шрифт",
    "кастомизация",
    "язык",
  );

  if (normalizeSearch(searchQuery) && !themeVisible && !moreVisible) {
    return null;
  }

  return (
    <View style={ui.tabBody}>
      {themeVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Тема</Text>
          <View style={ui.fieldsStack}>
            <Text style={ui.sectionHint}>Тёмная тема Flora активна по умолчанию.</Text>
          </View>
        </View>
      ) : null}
      {moreVisible ? (
        <View style={ui.section}>
          <Text style={ui.sectionTitle}>Оформление</Text>
          <View style={ui.fieldsStack}>
            <Text style={ui.sectionHint}>
              Кастомизация акцентов и шрифтов — в следующих версиях.
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

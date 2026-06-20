import { Text, View } from "react-native";
import { authStyles } from "./styles";

const LOGO_LETTERS: { ch: string; idGap?: boolean }[] = [
  ..."FLORA".split("").map((ch) => ({ ch })),
  ..."ID".split("").map((ch, i) => ({ ch, idGap: i === 0 })),
];

export function AuthLogo() {
  return (
    <View style={authStyles.logoRow} accessibilityRole="header" accessibilityLabel="FLORA ID">
      {LOGO_LETTERS.map(({ ch, idGap }, index) => (
        <Text
          key={`${ch}-${index}`}
          style={[authStyles.logoLetter, idGap ? authStyles.logoIdGap : null]}
        >
          {ch}
        </Text>
      ))}
    </View>
  );
}

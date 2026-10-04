import QuickCryptoModule, { install as installQuickCrypto } from "react-native-quick-crypto";

const install =
  typeof installQuickCrypto === "function"
    ? installQuickCrypto
    : (QuickCryptoModule as { install?: () => void }).install;

if (typeof install === "function") {
  install();
}

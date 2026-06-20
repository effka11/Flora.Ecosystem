import NetInfo from "@react-native-community/netinfo";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { floraColors } from "@/lib/theme";

export function OfflineBanner() {
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const sub = NetInfo.addEventListener((state) => {
      setOffline(!(state.isConnected && state.isInternetReachable !== false));
    });
    return () => sub();
  }, []);

  if (!offline) return null;

  return (
    <View style={styles.banner}>
      <Text style={styles.text}>Нет подключения к интернету</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: floraColors.error,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  text: {
    color: floraColors.text,
    textAlign: "center",
    fontSize: 13,
  },
});

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { FeedHamburgerMenu } from "@/components/FeedHamburgerMenu";

type HamburgerMenuContextValue = {
  open: boolean;
  openMenu: () => void;
  closeMenu: () => void;
};

const HamburgerMenuContext = createContext<HamburgerMenuContextValue | null>(null);

export function HamburgerMenuProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openMenu = useCallback(() => setOpen(true), []);
  const closeMenu = useCallback(() => setOpen(false), []);
  const value = useMemo(() => ({ open, openMenu, closeMenu }), [open, openMenu, closeMenu]);

  return (
    <HamburgerMenuContext.Provider value={value}>
      <View style={styles.host}>
        {children}
        <FeedHamburgerMenu visible={open} onClose={closeMenu} />
      </View>
    </HamburgerMenuContext.Provider>
  );
}

export function useHamburgerMenu(): HamburgerMenuContextValue {
  const ctx = useContext(HamburgerMenuContext);
  if (!ctx) {
    throw new Error("useHamburgerMenu must be used within HamburgerMenuProvider");
  }
  return ctx;
}

const styles = StyleSheet.create({
  host: {
    flex: 1,
  },
});

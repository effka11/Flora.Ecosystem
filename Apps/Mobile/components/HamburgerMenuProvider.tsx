import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import { StyleSheet } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { FeedHamburgerMenu } from "@/components/FeedHamburgerMenu";

type HamburgerMenuContextValue = {
  openMenu: () => void;
  closeMenu: () => void;
};

const HamburgerMenuContext = createContext<HamburgerMenuContextValue | null>(null);

/**
 * open-state живёт здесь, а не в Provider: смена open не ререндерит tabs children
 * (иначе весь экран под меню дёргается на старте/конце анимации).
 */
function HamburgerMenuHost({
  openMenuRef,
  closeMenuRef,
}: {
  openMenuRef: MutableRefObject<() => void>;
  closeMenuRef: MutableRefObject<() => void>;
}) {
  const [open, setOpen] = useState(false);
  const openMenu = useCallback(() => setOpen(true), []);
  const closeMenu = useCallback(() => setOpen(false), []);

  useEffect(() => {
    openMenuRef.current = openMenu;
    closeMenuRef.current = closeMenu;
  }, [closeMenu, closeMenuRef, openMenu, openMenuRef]);

  return <FeedHamburgerMenu visible={open} onOpen={openMenu} onClose={closeMenu} />;
}

export function HamburgerMenuProvider({ children }: { children: ReactNode }) {
  const openMenuRef = useRef(() => {});
  const closeMenuRef = useRef(() => {});
  // Стабильный value: потребители (header/messages) не подписаны на open и не ререндерятся.
  const value = useMemo<HamburgerMenuContextValue>(
    () => ({
      openMenu: () => openMenuRef.current(),
      closeMenu: () => closeMenuRef.current(),
    }),
    [],
  );

  return (
    <GestureHandlerRootView style={styles.host}>
      <HamburgerMenuContext.Provider value={value}>{children}</HamburgerMenuContext.Provider>
      <HamburgerMenuHost openMenuRef={openMenuRef} closeMenuRef={closeMenuRef} />
    </GestureHandlerRootView>
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

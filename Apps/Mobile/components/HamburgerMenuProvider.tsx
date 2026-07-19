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
import { DrawerMomentumProvider } from "@/lib/drawerMomentum";

type HamburgerMenuContextValue = {
  openMenu: () => void;
  closeMenu: () => void;
};

const HamburgerMenuContext = createContext<HamburgerMenuContextValue | null>(null);

/**
 * open-state живёт здесь: смена open ререндерит меню, но не tabs —
 * children в memo-слоте FeedHamburgerMenu со стабильной ссылкой из Provider.
 */
function HamburgerMenuHost({
  openMenuRef,
  closeMenuRef,
  children,
}: {
  openMenuRef: MutableRefObject<() => void>;
  closeMenuRef: MutableRefObject<() => void>;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const openMenu = useCallback(() => setOpen(true), []);
  const closeMenu = useCallback(() => setOpen(false), []);

  useEffect(() => {
    openMenuRef.current = openMenu;
    closeMenuRef.current = closeMenu;
  }, [closeMenu, closeMenuRef, openMenu, openMenuRef]);

  return (
    <FeedHamburgerMenu visible={open} onOpen={openMenu} onClose={closeMenu}>
      {children}
    </FeedHamburgerMenu>
  );
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
      <DrawerMomentumProvider>
        <HamburgerMenuContext.Provider value={value}>
          <HamburgerMenuHost openMenuRef={openMenuRef} closeMenuRef={closeMenuRef}>
            {children}
          </HamburgerMenuHost>
        </HamburgerMenuContext.Provider>
      </DrawerMomentumProvider>
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

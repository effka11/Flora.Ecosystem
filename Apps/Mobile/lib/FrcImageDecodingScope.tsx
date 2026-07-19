import { createContext, useContext, type ReactNode } from "react";

const FrcImageDecodingEnabledContext = createContext(true);

export function FrcImageDecodingScope({
  enabled,
  children,
}: {
  enabled: boolean;
  children: ReactNode;
}) {
  return (
    <FrcImageDecodingEnabledContext.Provider value={enabled}>
      {children}
    </FrcImageDecodingEnabledContext.Provider>
  );
}

export function useFrcImageDecodingEnabled(): boolean {
  return useContext(FrcImageDecodingEnabledContext);
}

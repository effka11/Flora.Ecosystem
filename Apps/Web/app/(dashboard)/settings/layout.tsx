import type { ReactNode } from "react";
import { floraPageMetadata } from "@/lib/floraDocumentTitle";

export const metadata = floraPageMetadata("Настройки");

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return children;
}

import type { ReactNode } from "react";
import { floraPageMetadata } from "@/lib/floraDocumentTitle";

export const metadata = floraPageMetadata("Профиль");

export default function ProfileLayout({ children }: { children: ReactNode }) {
  return children;
}

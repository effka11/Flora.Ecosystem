import type { ReactNode } from "react";
import { floraPageMetadata } from "@/lib/floraDocumentTitle";

export const metadata = floraPageMetadata("Жанр");

export default function MusicGenreSectionLayout({ children }: { children: ReactNode }) {
  return children;
}

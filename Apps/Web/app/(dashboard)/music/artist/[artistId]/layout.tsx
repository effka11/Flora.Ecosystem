import type { ReactNode } from "react";
import { floraPageMetadata } from "@/lib/floraDocumentTitle";

export const metadata = floraPageMetadata("Артист");

export default function MusicArtistLayout({ children }: { children: ReactNode }) {
  return children;
}

import type { ReactNode } from "react";
import { floraPageMetadata } from "@/lib/floraDocumentTitle";

export const metadata = floraPageMetadata("Люди");

export default function PeopleLayout({ children }: { children: ReactNode }) {
  return children;
}

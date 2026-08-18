import type { Metadata } from "next";
import { GOV_PAGE_ITEMS, type GovNavItem } from "@/app/_shell/govNavigation";
import { formatGovDocumentTitle } from "@/lib/floraDocumentTitle";

function requireNavItem(href: string): GovNavItem {
  const item = GOV_PAGE_ITEMS.find((entry) => entry.href === href);
  if (!item) {
    throw new Error(`GOV_PAGE_ITEMS has no entry for ${href}`);
  }
  return item;
}

export const CIVIC_NAV = {
  overview: requireNavItem("/overview"),
  moderation: requireNavItem("/moderation"),
  constitution: requireNavItem("/constitution"),
  journal: requireNavItem("/journal"),
  proposals: requireNavItem("/proposals"),
  sortition: requireNavItem("/sortition"),
  treasury: requireNavItem("/treasury"),
  circles: requireNavItem("/circles"),
} as const;

export function civicPageMetadata(nav: GovNavItem): Metadata {
  return {
    title: {
      absolute: formatGovDocumentTitle(nav.label),
    },
  };
}

import {
  COMMUNITY_SLUG_FORMAT_MESSAGE,
  COMMUNITY_SLUG_RE,
  hasOnlyCommunitySlugChars,
  normalizeCommunitySlug,
} from "@/app/(dashboard)/communities/communitySlug";
import { isReservedCommunitySlug, RESERVED_COMMUNITY_SLUG_MESSAGE } from "@/lib/communityReservedSlugs";
import type { CommunityProfileDto } from "@/lib/socialApi";

export type CommunitySettingsDraft = {
  name: string;
  slug: string;
  isPrivate: boolean;
};

export function communitySettingsDraftFromProfile(community: CommunityProfileDto): CommunitySettingsDraft {
  return {
    name: community.name,
    slug: community.slug,
    isPrivate: community.isPrivate ?? true,
  };
}

export function communitySettingsDraftHasChanges(
  draft: CommunitySettingsDraft,
  community: CommunityProfileDto,
): boolean {
  return (
    draft.name.trim() !== community.name.trim() ||
    normalizeCommunitySlug(draft.slug) !== normalizeCommunitySlug(community.slug) ||
    draft.isPrivate !== (community.isPrivate ?? true)
  );
}

export function validateCommunitySettingsDraft(draft: CommunitySettingsDraft): string | null {
  const trimmedName = draft.name.trim();
  const trimmedSlug = draft.slug.trim();

  if (!trimmedName) return "Укажите название сообщества.";
  if (trimmedName.length > 100) return "Название не более 100 символов.";
  if (!hasOnlyCommunitySlugChars(trimmedSlug)) return COMMUNITY_SLUG_FORMAT_MESSAGE;

  const normalizedSlug = normalizeCommunitySlug(trimmedSlug);
  if (!COMMUNITY_SLUG_RE.test(normalizedSlug)) return COMMUNITY_SLUG_FORMAT_MESSAGE;
  if (isReservedCommunitySlug(normalizedSlug)) return RESERVED_COMMUNITY_SLUG_MESSAGE;

  return null;
}

export function communitySettingsDraftToUpdatePayload(draft: CommunitySettingsDraft): {
  name: string;
  slug: string;
  isPrivate: boolean;
} {
  return {
    name: draft.name.trim(),
    slug: normalizeCommunitySlug(draft.slug),
    isPrivate: draft.isPrivate,
  };
}

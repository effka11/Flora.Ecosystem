import type { FeedPostDto } from "@flora/client-core/contracts";
import { profileDisplayName } from "@flora/client-core/display";
import type { Href } from "expo-router";

export type FeedPostAuthorMeta = {
  label: string;
  href: Href;
  showHandle: boolean;
  avatarUuid: string | null;
  seed: string;
  displayName: string;
  username: string;
  communityName?: string;
};

function profileHref(username: string): Href {
  const slug = username.trim().replace(/^@+/, "");
  return `/profile/${encodeURIComponent(slug || "user")}`;
}

function communityHref(slug: string): Href {
  return `/communities/${encodeURIComponent(slug.trim())}`;
}

/** Синхронно с Web `feedPostAuthor()` в feed/page.tsx */
export function feedPostAuthor(post: FeedPostDto): FeedPostAuthorMeta {
  if (post.communityName) {
    return {
      label: post.communityName,
      href: post.communitySlug ? communityHref(post.communitySlug) : profileHref(post.authorUsername),
      showHandle: false,
      avatarUuid: post.communityAvatarUuid ?? null,
      seed: post.communityUuid ?? post.communitySlug ?? post.communityName,
      communityName: post.communityName,
      displayName: post.communityName,
      username: post.communitySlug ?? "",
    };
  }
  return {
    label: profileDisplayName(post.authorDisplayName, post.authorUsername),
    href: profileHref(post.authorUsername),
    showHandle: true,
    avatarUuid: post.authorAvatarUuid ?? null,
    seed: post.authorUserUuid ?? post.authorUsername,
    displayName: post.authorDisplayName,
    username: post.authorUsername,
  };
}

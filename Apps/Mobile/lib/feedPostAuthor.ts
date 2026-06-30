import type { FeedPostDto } from "@flora/client-core/contracts";
import { profileDisplayName } from "@flora/client-core/display";
import type { Href } from "expo-router";
import { communityScreenHref, profileScreenHref } from "@/lib/socialRoutes";

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

/** Синхронно с Web `feedPostAuthor()` в feed/page.tsx */
export function feedPostAuthor(post: FeedPostDto, meUsername?: string | null): FeedPostAuthorMeta {
  if (post.communityName) {
    return {
      label: post.communityName,
      href: post.communitySlug
        ? communityScreenHref(post.communitySlug)
        : profileScreenHref(post.authorUsername, meUsername),
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
    href: profileScreenHref(post.authorUsername, meUsername),
    showHandle: true,
    avatarUuid: post.authorAvatarUuid ?? null,
    seed: post.authorUserUuid ?? post.authorUsername,
    displayName: post.authorDisplayName,
    username: post.authorUsername,
  };
}

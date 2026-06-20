import type { PostEngagementSnapshot } from "@flora/client-core/contracts";
import { apiLikePost, apiRepostPost, apiUnlikePost, apiUnrepostPost } from "@flora/client-core/api";
import { useCallback, useRef, useState } from "react";

export type PostEngagementSource = {
  postUuid: string;
  likesCount: number;
  repostsCount: number;
  liked?: boolean;
  reposted?: boolean;
};

type EngagementOverride = Partial<PostEngagementSnapshot>;

type UsePostEngagementOptions = {
  onEngagementChange?: (postUuid: string, snapshot: PostEngagementSnapshot) => void;
};

export function feedPostToEngagementSource(post: {
  postUuid: string;
  likeCount: number;
  repostCount: number;
  likedByMe: boolean;
  repostedByMe: boolean;
}): PostEngagementSource {
  return {
    postUuid: post.postUuid,
    likesCount: post.likeCount,
    repostsCount: post.repostCount,
    liked: post.likedByMe,
    reposted: post.repostedByMe,
  };
}

export function usePostEngagement(options: UsePostEngagementOptions = {}) {
  const { onEngagementChange } = options;
  const onChangeRef = useRef(onEngagementChange);
  onChangeRef.current = onEngagementChange;

  const [overrides, setOverrides] = useState<Record<string, EngagementOverride>>({});
  const [pending, setPending] = useState<Record<string, "like" | "repost">>({});

  const snapshotFor = useCallback(
    (post: PostEngagementSource): PostEngagementSnapshot => {
      const o = overrides[post.postUuid];
      return {
        liked: o?.liked ?? post.liked ?? false,
        reposted: o?.reposted ?? post.reposted ?? false,
        likesCount: o?.likesCount ?? post.likesCount,
        repostsCount: o?.repostsCount ?? post.repostsCount,
      };
    },
    [overrides],
  );

  const applySnapshot = useCallback((postUuid: string, snapshot: PostEngagementSnapshot) => {
    setOverrides((prev) => ({ ...prev, [postUuid]: snapshot }));
    onChangeRef.current?.(postUuid, snapshot);
  }, []);

  const toggleLike = useCallback(
    async (post: PostEngagementSource) => {
      if (pending[post.postUuid]) return;
      const before = snapshotFor(post);
      const nextLiked = !before.liked;
      const optimistic: PostEngagementSnapshot = {
        ...before,
        liked: nextLiked,
        likesCount: Math.max(0, before.likesCount + (nextLiked ? 1 : -1)),
      };
      applySnapshot(post.postUuid, optimistic);
      setPending((p) => ({ ...p, [post.postUuid]: "like" }));
      try {
        const result = nextLiked ? await apiLikePost(post.postUuid) : await apiUnlikePost(post.postUuid);
        applySnapshot(post.postUuid, { ...before, liked: result.liked, likesCount: result.likesCount });
      } catch {
        applySnapshot(post.postUuid, before);
      } finally {
        setPending((p) => {
          const next = { ...p };
          delete next[post.postUuid];
          return next;
        });
      }
    },
    [applySnapshot, pending, snapshotFor],
  );

  const toggleRepost = useCallback(
    async (post: PostEngagementSource) => {
      if (pending[post.postUuid]) return;
      const before = snapshotFor(post);
      const nextReposted = !before.reposted;
      const optimistic: PostEngagementSnapshot = {
        ...before,
        reposted: nextReposted,
        repostsCount: Math.max(0, before.repostsCount + (nextReposted ? 1 : -1)),
      };
      applySnapshot(post.postUuid, optimistic);
      setPending((p) => ({ ...p, [post.postUuid]: "repost" }));
      try {
        const result = nextReposted
          ? await apiRepostPost(post.postUuid)
          : await apiUnrepostPost(post.postUuid);
        applySnapshot(post.postUuid, {
          ...before,
          reposted: result.reposted,
          repostsCount: result.repostsCount,
        });
      } catch {
        applySnapshot(post.postUuid, before);
      } finally {
        setPending((p) => {
          const next = { ...p };
          delete next[post.postUuid];
          return next;
        });
      }
    },
    [applySnapshot, pending, snapshotFor],
  );

  const isLikePending = useCallback((postUuid: string) => pending[postUuid] === "like", [pending]);
  const isRepostPending = useCallback((postUuid: string) => pending[postUuid] === "repost", [pending]);

  return {
    snapshotFor,
    toggleLike,
    toggleRepost,
    isLikePending,
    isRepostPending,
  };
}

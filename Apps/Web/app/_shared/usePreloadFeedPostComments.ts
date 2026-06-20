"use client";

import { useEffect, useMemo } from "react";
import { preloadPostComments } from "@/lib/postCommentsCache";

type PostWithCommentsCount = { postUuid: string; commentsCount: number };

/** Фоновая предзагрузка корневых комментариев для постов ленты. */
export function usePreloadFeedPostComments(posts: PostWithCommentsCount[]): void {
  const postUuids = useMemo(
    () => posts.filter((p) => p.commentsCount > 0).map((p) => p.postUuid),
    [posts],
  );

  useEffect(() => {
    if (postUuids.length === 0) return;
    preloadPostComments(postUuids);
  }, [postUuids]);
}

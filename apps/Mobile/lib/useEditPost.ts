import type { FeedPostDto } from "@flora/client-core/contracts";
import { createElement, useCallback, useState, type ReactNode } from "react";
import { EditPostSheet } from "@/components/feed/EditPostSheet";

export function useEditPost(): {
  openEditPost: (post: FeedPostDto) => void;
  editSheet: ReactNode;
} {
  const [post, setPost] = useState<FeedPostDto | null>(null);
  const close = useCallback(() => setPost(null), []);
  return {
    openEditPost: setPost,
    editSheet: createElement(EditPostSheet, { post, onClose: close }),
  };
}

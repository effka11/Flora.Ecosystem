"use client";

import Link from "next/link";
import { useMemo } from "react";
import { formatAtHandle, profilePathFromUsername } from "@/app/_dashboard/userDisplay";
import { parseCommentTextParts } from "@/lib/commentMentionComposer";
import styles from "./FeedPostComments.module.css";

type CommentBodyTextProps = {
  content: string;
  className?: string;
};

export function CommentBodyText({ content, className }: CommentBodyTextProps) {
  const parts = useMemo(() => parseCommentTextParts(content), [content]);

  return (
    <p className={className}>
      {parts.map((part, index) =>
        part.kind === "mention" ? (
          <Link
            key={`mention-${index}`}
            href={profilePathFromUsername(part.username)}
            className={styles.mentionChip}
          >
            {formatAtHandle(part.username)}
          </Link>
        ) : (
          <span key={`text-${index}`}>{part.value}</span>
        ),
      )}
    </p>
  );
}

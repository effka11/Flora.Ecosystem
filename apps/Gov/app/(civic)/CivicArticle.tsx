import type { ReactNode } from "react";
import { GovBadge } from "@/app/_shell/GovBadge";
import type { GovNavItem } from "@/app/_shell/govNavigation";
import styles from "./civicArticle.module.css";

export type CivicArticleProps = {
  nav: GovNavItem;
  children: ReactNode;
  className?: string;
};

export function CivicArticle({ nav, children, className }: CivicArticleProps) {
  const articleClassName = className ? `${styles.article} ${className}` : styles.article;

  return (
    <article className={articleClassName}>
      <h1 className={styles.heading}>{nav.label}</h1>
      <div className={styles.body}>{children}</div>
      {nav.status === "shell" ? <GovBadge /> : null}
    </article>
  );
}

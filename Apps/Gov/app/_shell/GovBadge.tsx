import styles from "./govBadge.module.css";

export type GovBadgeProps = {
  text?: string;
};

const DEFAULT_BADGE_TEXT = "нет runtime FGP";

export function GovBadge({ text = DEFAULT_BADGE_TEXT }: GovBadgeProps) {
  return (
    <p className={styles.badge} role="status">
      {text}
    </p>
  );
}

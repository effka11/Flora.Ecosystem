import styles from "./floraLogoMark.module.css";

/** Corner mark at the logo's own scale. The tab icon is a tighter crop of the same mark. */
export function FloraLogoMark() {
  return (
    <span className={styles.mark} aria-hidden>
      <span className={styles.markGlyph} />
    </span>
  );
}

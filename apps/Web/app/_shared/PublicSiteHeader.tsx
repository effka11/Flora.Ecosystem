import Link from "next/link";
import { FloraLogoMark } from "@/app/_shared/FloraLogoMark";
import { FLORA_TITLE_SEPARATOR } from "@/lib/floraDocumentTitle";
import styles from "./publicSite.module.css";

/** Sticky FLORA logo + «Войти» for public pages (/rules, /download, …). */
export function PublicSiteHeader() {
  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <Link href="/login" className={styles.logo} aria-label={`Flora${FLORA_TITLE_SEPARATOR}вход`}>
          <FloraLogoMark />
          <span className={styles.logoText}>FLORA</span>
        </Link>
        <Link className={styles.loginLink} href="/login">
          Войти
        </Link>
      </div>
    </header>
  );
}

export { styles as publicSiteStyles };

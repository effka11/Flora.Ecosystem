import Link from "next/link";
import styles from "./profile.module.css";

export function ProfileOwnHeaderActions() {
  return (
    <div className={styles.profileHeaderActions}>
      <Link href="/compose?mode=primary" className={styles.profileActionBtn}>
        Сделать пост
      </Link>
      <Link href="/settings?section=account" className={styles.profileActionBtn}>
        Редактировать профиль
      </Link>
    </div>
  );
}

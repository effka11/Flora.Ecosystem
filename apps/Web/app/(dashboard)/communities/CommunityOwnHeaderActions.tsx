import Link from "next/link";
import { communitySettingsHref } from "@/app/(dashboard)/communities/communitiesSeed";
import { composeCommunityModeId } from "@/app/(dashboard)/feed/compose/composeModes";
import styles from "@/app/(dashboard)/profile/profile.module.css";

type CommunityOwnHeaderActionsProps = {
  communityId: string;
  communitySlug?: string;
};

export function CommunityOwnHeaderActions({ communityId, communitySlug }: CommunityOwnHeaderActionsProps) {
  const composeHref = `/compose?mode=${encodeURIComponent(composeCommunityModeId(communityId))}`;
  const settingsHref = communitySettingsHref({ id: communityId, slug: communitySlug });

  return (
    <div className={styles.profileHeaderActions}>
      <Link href={composeHref} className={styles.profileActionBtn}>
        Сделать пост
      </Link>
      <Link href={settingsHref} className={styles.profileActionBtn}>
        Настройки
      </Link>
    </div>
  );
}

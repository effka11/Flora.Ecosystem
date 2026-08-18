import type { Metadata } from "next";
import { CivicArticle } from "../CivicArticle";
import { CIVIC_NAV, civicPageMetadata } from "../civicNav";
import styles from "./overview.module.css";

const nav = CIVIC_NAV.overview;

export const metadata: Metadata = civicPageMetadata(nav);

export default function OverviewPage() {
  return (
    <CivicArticle nav={nav} className={styles.page}>
      <p>
        Flora Gov — гражданский портал Flora. Это отдельный продукт от социальной сети:
        другая витрина, тот же аккаунт.
      </p>
      <p>
        Здесь читают конституцию и разбирают жалобы на сообщения. Текст переписки сервер
        не видит. Лента, ключи и личные данные на этот портал не попадают.
      </p>
      <p>
        Управление касается только общего: правил модерации, дефолтов продукта и изменений
        протокола. Предложения, жребий, казна и круги появятся позже.
      </p>
    </CivicArticle>
  );
}

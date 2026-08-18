import type { Metadata } from "next";
import { CivicArticle } from "../CivicArticle";
import { CIVIC_NAV, civicPageMetadata } from "../civicNav";
import styles from "./circles.module.css";

const nav = CIVIC_NAV.circles;

export const metadata: Metadata = civicPageMetadata(nav);

export default function CirclesPage() {
  return (
    <CivicArticle nav={nav} className={styles.page}>
      <p>
        Круг домена служит операционным органом тира T1+ внутри домена компетенции (инженерия,
        безопасность протокола, политика модерации, продукт и интерфейс, инфраструктура,
        документация и локализация, сообщество). Он принимает обратимые решения R0/R1
        своего домена процедурой согласия и связан с общим кругом двойной связью через двух
        разных представителей. Общий круг занимается межкоординацией, календарём и спорами
        о границах доменов и не может решать за домен. Кластеры живут своими локальными
        правилами, но глобальный пол Слоя 0 им не отменить.
      </p>
    </CivicArticle>
  );
}

import type { Metadata } from "next";
import { CivicArticle } from "../CivicArticle";
import { CIVIC_NAV, civicPageMetadata } from "../civicNav";
import styles from "./sortition.module.css";

const nav = CIVIC_NAV.sortition;

export const metadata: Metadata = civicPageMetadata(nav);

export default function SortitionPage() {
  return (
    <CivicArticle nav={nav} className={styles.page}>
      <p>
        Жребий входит в четыре канала легитимности: сортиционные жюри со
        стратификацией гасят лоббизм и окапывание элит. Жюри набирается из пула V2+ со
        стажем не менее 6 месяцев и живым присутствием; мандат действует на один кейс,
        частота службы не больше четырёх кейсов в год. Стратификация идёт по кластерам
        мнений, стажу и географии; состав заранее неизвестен, поэтому подкупать «нужных
        людей» бессмысленно. Выбытие в ходе кейса заменяется резервом той же страты.
      </p>
    </CivicArticle>
  );
}

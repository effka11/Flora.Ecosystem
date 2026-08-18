import type { Metadata } from "next";
import { CivicArticle } from "../CivicArticle";
import { CIVIC_NAV, civicPageMetadata } from "../civicNav";
import styles from "./proposals.module.css";

const nav = CIVIC_NAV.proposals;

export const metadata: Metadata = civicPageMetadata(nav);

export default function ProposalsPage() {
  return (
    <CivicArticle nav={nav} className={styles.page}>
      <p>
        Предложение (RFC) проходит конвейер S0–S8: черновик по шаблону с ZK-залогом, триаж
        формы (не вкуса) сортиционным жюри, структурирование графа аргументов и карты
        влияния, анонимная делиберация, социократический consent gate, решение по классу
        обратимости (R0–R3), имплементация с конформансом и time-lock, затем авто-экспирация
        и сверка фактов с обещаниями. Подать черновик может любой верифицированный человек;
        круг и жюри не запрещают подачу, только классифицируют и триажируют.
      </p>
    </CivicArticle>
  );
}

import type { Metadata } from "next";
import { CivicArticle } from "../CivicArticle";
import { CIVIC_NAV, civicPageMetadata } from "../civicNav";
import styles from "./treasury.module.css";

const nav = CIVIC_NAV.treasury;

export const metadata: Metadata = civicPageMetadata(nav);

export default function TreasuryPage() {
  return (
    <CivicArticle nav={nav} className={styles.page}>
      <p>
        Казна Commons оплачивает инфраструктуру, аудиты, юридическую защиту и доступность
        так, чтобы деньги не конвертировались во власть. Донат не покупает вес, приоритет
        триажа или доступ: поступления смешиваются в общий пул, а бюджет проходит ту же
        двухключевую модель, что и прочие решения. Казна не вправе покупать или продавать
        governance-права, финансировать нарушение Слоя 0, скрывать категории расходов или
        брать долг с правом влияния кредитора. Параметры экономического слоя FEP (включая
        LIV) протокол задаёт отдельно; конвертация «деньги → власть» закрыта инвариантом.
      </p>
    </CivicArticle>
  );
}

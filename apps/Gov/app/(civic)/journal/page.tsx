import type { Metadata } from "next";
import { CivicArticle } from "../CivicArticle";
import { CIVIC_NAV, civicPageMetadata } from "../civicNav";
import styles from "./journal.module.css";

const nav = CIVIC_NAV.journal;

export const metadata: Metadata = civicPageMetadata(nav);

export default function JournalPage() {
  return (
    <CivicArticle nav={nav} className={styles.page}>
      <p>
        Все действия модерации слоёв L0–L4 и все события управления пишутся в append-only
        журнал с хеш-цепочкой. Агрегаты (объёмы, категории, апелляции) открыты; выборочный
        аудит журнала это регулярная задача сортиционных жюри. Заголовок журнала
        периодически подписывают независимые наблюдатели (витнесс-косайнинг), и клиенты
        принимают журнал только при совпадении косайнов, чтобы исключить split-view. Хеш
        заголовка якорится во внешних независимых носителях: сговор витнессов может
        подделать будущее, но не прошлое глубже последнего якоря.
      </p>
    </CivicArticle>
  );
}

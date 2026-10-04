import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GovAuthGate } from "@/app/_shell/GovAuthGate";
import { FLORA_TITLE_SEPARATOR } from "@/lib/floraDocumentTitle";

export const metadata: Metadata = {
  description: `Flora Gov${FLORA_TITLE_SEPARATOR}гражданский портал`,
};

/**
 * Единственный шов авторизации для гражданских маршрутов: страницы группы не
 * проверяют сессию сами, поэтому новая функция получает гейт вместе с шеллом.
 * Страницы рендерятся на сервере и приходят сюда как props, но в DOM попадают
 * только при решении `shell`; данных гражданина в них нет.
 *
 * Собственное уведомление `/moderation` про «нужен вход» остаётся до части,
 * которая заменит страницу очередью модерации.
 *
 * Принятый остаточный риск: гейт email существует только на клиенте. Messaging
 * не читает базу Auth, а в JWT нет клейма `emailVerified`, поэтому другой клиент
 * с тем же токеном его обходит. Серверный порт или клейм в JWT решаются отдельно.
 */
export default function CivicLayout({ children }: { children: ReactNode }) {
  return <GovAuthGate>{children}</GovAuthGate>;
}

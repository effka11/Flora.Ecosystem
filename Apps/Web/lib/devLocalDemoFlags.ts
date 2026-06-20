/**
 * Офлайн-демо UI: только при `NEXT_PUBLIC_DEV_AUTO_AUTH=1` И вне production-сборки.
 * Гарантия, что демо-режим никогда не попадёт в прод даже при ошибочно выставленном флаге.
 */
export const DEV_LOCAL_RICH_UI =
  process.env.NEXT_PUBLIC_DEV_AUTO_AUTH === "1" && process.env.NODE_ENV !== "production";

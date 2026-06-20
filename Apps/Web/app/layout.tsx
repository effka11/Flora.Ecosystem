import type { Metadata } from "next";
import localFont from "next/font/local";
import { FontReadyGate } from "@/app/_shared/FontReadyGate";
import { webBuildId } from "@/lib/buildId";
import "./globals.css";

/** Локальные woff2 из npm — билд не ходит в Google Fonts (офлайн / блокировки). */
const manrope = localFont({
  src: [
    {
      path: "../node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2",
      weight: "200 800",
      style: "normal",
    },
    {
      path: "../node_modules/@fontsource-variable/manrope/files/manrope-latin-ext-wght-normal.woff2",
      weight: "200 800",
      style: "normal",
    },
    {
      path: "../node_modules/@fontsource-variable/manrope/files/manrope-cyrillic-wght-normal.woff2",
      weight: "200 800",
      style: "normal",
    },
    {
      path: "../node_modules/@fontsource-variable/manrope/files/manrope-cyrillic-ext-wght-normal.woff2",
      weight: "200 800",
      style: "normal",
    },
  ],
  variable: "--font-manrope",
  display: "swap",
  adjustFontFallback: "Arial",
});

export const metadata: Metadata = {
  title: "Flora ID — вход",
  description: "Вход в Flora",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const buildId = webBuildId();
  const cacheBustScript = buildId
    ? `(function(){var v=${JSON.stringify(buildId)};var p=location.pathname;var q=new URLSearchParams(location.search);if((p==="/"||p==="/login")&&q.get("b")!==v)location.replace("/login?b="+encodeURIComponent(v)+location.hash);})();`
    : "";

  return (
    <html lang="ru" className={manrope.variable} suppressHydrationWarning>
      <head suppressHydrationWarning>
        {cacheBustScript ? (
          <script dangerouslySetInnerHTML={{ __html: cacheBustScript }} />
        ) : null}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){function u(){var b=document.body;if(!b)return;b.classList.remove("fonts-pending");b.classList.add("fonts-ready")}if(document.body)u();else document.addEventListener("DOMContentLoaded",u,{once:true});if(document.fonts&&document.fonts.ready)document.fonts.ready.then(u,u);setTimeout(u,2500)})();`,
          }}
        />
      </head>
      <body suppressHydrationWarning className={`${manrope.className} fonts-pending`}>
        <FontReadyGate />
        {children}
      </body>
    </html>
  );
}

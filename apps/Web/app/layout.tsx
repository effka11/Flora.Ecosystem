import type { Metadata } from "next";
import localFont from "next/font/local";
import { FontReadyGate } from "@/app/_shared/FontReadyGate";
import { FloraThemeProvider } from "@/app/_shared/FloraThemeProvider";
import { MonoTextLayer } from "@/app/_shared/MonoTextLayer";
import { webBuildId } from "@/lib/buildId";
import { FLORA_TITLE_SEPARATOR } from "@/lib/floraDocumentTitle";
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
  title: {
    default: "Flora",
    template: `Flora${FLORA_TITLE_SEPARATOR}%s`,
  },
  description: "Flora",
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
    ],
    apple: [{ url: "/apple-icon.png", sizes: "180x180", type: "image/png" }],
    shortcut: "/favicon-32.png",
  },
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
            __html: `(function(){try{var raw=localStorage.getItem("flora.userSettings.prefs");var theme="dark";if(raw){var prefs=JSON.parse(raw);var stored=prefs&&prefs.customization&&prefs.customization.theme;if(stored==="light"||stored==="flora")theme=stored}document.documentElement.setAttribute("data-flora-theme",theme)}catch(e){document.documentElement.setAttribute("data-flora-theme","dark")}})();`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){function u(){var b=document.body;if(!b)return;b.classList.remove("fonts-pending");b.classList.add("fonts-ready")}if(document.body)u();else document.addEventListener("DOMContentLoaded",u,{once:true});if(document.fonts&&document.fonts.ready)document.fonts.ready.then(u,u);setTimeout(u,2500)})();`,
          }}
        />
      </head>
      <body suppressHydrationWarning className={`${manrope.className} fonts-pending`}>
        <FloraThemeProvider>
          <FontReadyGate />
          <MonoTextLayer />
          {children}
        </FloraThemeProvider>
      </body>
    </html>
  );
}

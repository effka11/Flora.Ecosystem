---
name: flora-ui-dash-separator
description: >-
  Разделитель тире в пользовательском тексте apps/Web: en-dash и двойной NBSP,
  константа FLORA_TITLE_SEPARATOR. Вызывай перед правками видимых строк,
  document title, aria-label и metadata в apps/Web.
---

# Разделитель «тире» в UI-тексте apps/Web

В пользовательском копирайте (правила, aria-label, описания, вкладки браузера) не использовать длинное тире `—` (U+2014).

## Стандарт

Формат: два неразрывных пробела + en-dash + два неразрывных пробела.

- Константа SoT: `FLORA_TITLE_SEPARATOR` в `apps/Web/lib/floraDocumentTitle.ts`
- Значение: `"\u00A0\u00A0–\u00A0\u00A0"` → визуально `Flora  –  Сообщения`

## Почему NBSP

Обычные пробелы (` `) HTML/CSS схлопывает в один — двойной отступ не виден в DOM-тексте и в `<title>`. Всегда `\u00A0`, не `"  –  "`.

## Как писать

```ts
import { FLORA_TITLE_SEPARATOR } from "@/lib/floraDocumentTitle";

// правильно
`Тяжёлые нарушения${FLORA_TITLE_SEPARATOR}в том числе …`
aria-label={`Flora${FLORA_TITLE_SEPARATOR}вход`}
```

Длинное тире (`—`) и обычные пробелы вокруг en-dash писать нельзя: пробелы схлопнутся.

Для заголовков вкладок — `formatFloraDocumentTitle` / `floraPageMetadata` (уже через эту константу).

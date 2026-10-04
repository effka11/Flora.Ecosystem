import assert from "node:assert/strict";
import test from "node:test";
import {
  FLORA_GOV_DOCUMENT_TITLE,
  FLORA_TITLE_SEPARATOR,
  formatGovDocumentTitle,
} from "./floraDocumentTitle";

test("FLORA_TITLE_SEPARATOR uses en-dash and double NBSP, not em-dash or ordinary spaces", () => {
  assert.equal(FLORA_TITLE_SEPARATOR, "\u00A0\u00A0–\u00A0\u00A0");
  assert.equal([...FLORA_TITLE_SEPARATOR].length, 5);
  assert.ok(!FLORA_TITLE_SEPARATOR.includes("\u2014"));
  assert.ok(!FLORA_TITLE_SEPARATOR.includes(" "));
});

test("formatGovDocumentTitle joins page title with separator", () => {
  assert.equal(
    formatGovDocumentTitle("Модерация"),
    `${FLORA_GOV_DOCUMENT_TITLE}${FLORA_TITLE_SEPARATOR}Модерация`,
  );
});

test("formatGovDocumentTitle returns base title for empty or whitespace input", () => {
  assert.equal(formatGovDocumentTitle(""), FLORA_GOV_DOCUMENT_TITLE);
  assert.equal(formatGovDocumentTitle("   "), FLORA_GOV_DOCUMENT_TITLE);
});

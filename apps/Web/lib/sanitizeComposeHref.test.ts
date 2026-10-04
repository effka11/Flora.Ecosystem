import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeComposeHref } from "./sanitizeComposeHref";

test("allows ordinary HTTP(S) and same-origin links", () => {
  for (const href of [
    "https://flora.social/post/1",
    "HTTP://example.test/path",
    "/profile/flora",
    "#comments",
    "?tab=posts",
  ]) {
    assert.equal(sanitizeComposeHref(href), href);
  }
});

test("rejects executable, protocol-relative, credential and malformed links", () => {
  for (const href of [
    "javascript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "//evil.example/path",
    "/\\evil.example/path",
    "https://flora.social@evil.example/path",
    "https://user:password@example.test/",
    "not a URL",
  ]) {
    assert.equal(sanitizeComposeHref(href), null, href);
  }
});

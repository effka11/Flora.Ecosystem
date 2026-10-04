import assert from "node:assert/strict";
import test from "node:test";
import { FRANKING_MISSING_RECEIPT_WARNING as CORE_WARNING } from "@flora/client-core/display";
import { FRANKING_MISSING_RECEIPT_WARNING } from "./messageReport";

test("re-exports the delivery warning copy", () => {
  assert.equal(FRANKING_MISSING_RECEIPT_WARNING, CORE_WARNING);
});

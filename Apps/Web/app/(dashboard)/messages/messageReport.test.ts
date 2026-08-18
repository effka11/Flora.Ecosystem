import assert from "node:assert/strict";
import test from "node:test";
import { canReportMessage, FRANKING_REPORT_CATEGORY_OPTIONS } from "./messageReport";

test("incoming 1:1 message can be reported", () => {
  assert.equal(canReportMessage({ isFromMe: false, isGroupChat: false }), true);
});

test("own messages and groups cannot be reported", () => {
  assert.equal(canReportMessage({ isFromMe: true, isGroupChat: false }), false);
  assert.equal(canReportMessage({ isFromMe: false, isGroupChat: true }), false);
  assert.equal(
    canReportMessage({ isFromMe: false, isGroupChat: false, sendStatus: "sending" }),
    false,
  );
});

test("report categories match franking contract", () => {
  assert.deepEqual(
    FRANKING_REPORT_CATEGORY_OPTIONS.map((item) => item.value),
    ["abuse", "threats", "spam", "csam", "other"],
  );
});

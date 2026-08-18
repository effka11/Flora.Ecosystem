import assert from "node:assert/strict";
import test from "node:test";
import {
  emptySanctionDraft,
  hasSelectedSanctions,
  parseBlockDays,
  sanctionDraftToAccountBlock,
  setAccountBlockDays,
  setAccountBlockMode,
} from "./moderationSanctions";

test("empty draft has no selected block", () => {
  assert.equal(hasSelectedSanctions(emptySanctionDraft()), false);
});

test("forever is a complete choice", () => {
  const draft = setAccountBlockMode(emptySanctionDraft(), "forever");
  assert.equal(draft.mode, "forever");
  assert.equal(hasSelectedSanctions(draft), true);
});

test("timed without a valid day count is incomplete", () => {
  const draft = setAccountBlockMode(emptySanctionDraft(), "timed");
  assert.equal(draft.mode, "timed");
  assert.equal(hasSelectedSanctions(draft), false);
});

test("timed with a whole day count is complete", () => {
  const draft = setAccountBlockDays(emptySanctionDraft(), "7");
  assert.equal(draft.mode, "timed");
  assert.equal(draft.daysText, "7");
  assert.equal(hasSelectedSanctions(draft), true);
});

test("a second click on the same mode clears the choice", () => {
  let draft = setAccountBlockMode(emptySanctionDraft(), "forever");
  draft = setAccountBlockMode(draft, "forever");
  assert.equal(draft.mode, "none");
  assert.equal(hasSelectedSanctions(draft), false);
});

test("typing days switches from forever to timed and keeps the count", () => {
  let draft = setAccountBlockMode(emptySanctionDraft(), "forever");
  draft = setAccountBlockDays(draft, "30");
  assert.equal(draft.mode, "timed");
  assert.equal(draft.daysText, "30");
});

test("parseBlockDays accepts 1–9999 and rejects zero, junk and overflow", () => {
  assert.equal(parseBlockDays("1"), 1);
  assert.equal(parseBlockDays("9999"), 9999);
  assert.equal(parseBlockDays("0"), null);
  assert.equal(parseBlockDays("01"), null);
  assert.equal(parseBlockDays("10000"), null);
  assert.equal(parseBlockDays("7d"), null);
  assert.equal(parseBlockDays(""), null);
});

test("days input strips non-digits and caps at four characters", () => {
  const draft = setAccountBlockDays(emptySanctionDraft(), "12a345");
  assert.equal(draft.daysText, "1234");
});

test("sanctionDraftToAccountBlock omits key for none", () => {
  assert.equal(sanctionDraftToAccountBlock(emptySanctionDraft()), undefined);
});

test("sanctionDraftToAccountBlock maps forever to empty object", () => {
  const draft = setAccountBlockMode(emptySanctionDraft(), "forever");
  assert.deepEqual(sanctionDraftToAccountBlock(draft), {});
});

test("sanctionDraftToAccountBlock maps timed draft to days", () => {
  const draft = setAccountBlockDays(emptySanctionDraft(), "7");
  assert.deepEqual(sanctionDraftToAccountBlock(draft), { days: 7 });
});

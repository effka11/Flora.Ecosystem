import assert from "node:assert/strict";
import test from "node:test";
import {
  FEED_COMPACT_HYSTERESIS_PX,
  shouldFeedHeaderBeCompact,
} from "./useFeedCompactHeader";

const THRESHOLD = 60;

test("enter compact only when scrollTop is strictly above threshold", () => {
  assert.equal(shouldFeedHeaderBeCompact(THRESHOLD, THRESHOLD, false), false);
  assert.equal(shouldFeedHeaderBeCompact(THRESHOLD + 1, THRESHOLD, false), true);
  assert.equal(shouldFeedHeaderBeCompact(0, THRESHOLD, false), false);
});

test("leave compact only after hysteresis below threshold", () => {
  const leaveAt = THRESHOLD - FEED_COMPACT_HYSTERESIS_PX;
  assert.equal(shouldFeedHeaderBeCompact(THRESHOLD, THRESHOLD, true), true);
  assert.equal(shouldFeedHeaderBeCompact(leaveAt + 1, THRESHOLD, true), true);
  assert.equal(shouldFeedHeaderBeCompact(leaveAt, THRESHOLD, true), false);
  assert.equal(shouldFeedHeaderBeCompact(0, THRESHOLD, true), false);
});

test("boundary does not chatter: enter then stay through hysteresis band", () => {
  let compact = shouldFeedHeaderBeCompact(THRESHOLD + 1, THRESHOLD, false);
  assert.equal(compact, true);
  // Still inside band above leave line — stay compact.
  compact = shouldFeedHeaderBeCompact(THRESHOLD - 5, THRESHOLD, compact);
  assert.equal(compact, true);
  // Cross leave line — expand.
  compact = shouldFeedHeaderBeCompact(THRESHOLD - FEED_COMPACT_HYSTERESIS_PX, THRESHOLD, compact);
  assert.equal(compact, false);
  // Back into band but not above enter threshold — stay expanded.
  compact = shouldFeedHeaderBeCompact(THRESHOLD - 5, THRESHOLD, compact);
  assert.equal(compact, false);
});

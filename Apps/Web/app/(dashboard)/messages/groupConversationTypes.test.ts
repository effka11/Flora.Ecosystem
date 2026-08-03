import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatGroupMembersLabel } from "./groupConversationTypes";

describe("formatGroupMembersLabel", () => {
  it("uses Russian plural forms", () => {
    assert.equal(formatGroupMembersLabel(1), "1 участник");
    assert.equal(formatGroupMembersLabel(2), "2 участника");
    assert.equal(formatGroupMembersLabel(5), "5 участников");
    assert.equal(formatGroupMembersLabel(21), "21 участник");
    assert.equal(formatGroupMembersLabel(22), "22 участника");
    assert.equal(formatGroupMembersLabel(25), "25 участников");
    assert.equal(formatGroupMembersLabel(111), "111 участников");
  });
});

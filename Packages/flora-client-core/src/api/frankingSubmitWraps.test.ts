import { describe, expect, it } from "vitest";
import { selectFrankingSubmitWrapTargets } from "./frankingSubmitWraps.js";

const reporter = "11111111-1111-1111-1111-111111111111";
const accused = "22222222-2222-2222-2222-222222222222";

function target(userUuid: string, deviceUuid: string) {
  return { userUuid, deviceUuid, agreementPublicKeyBase64Url: "pk" };
}

describe("selectFrankingSubmitWrapTargets", () => {
  it("keeps reporter devices as backup and skips accused reviewers", () => {
    const selected = selectFrankingSubmitWrapTargets({
      ownItems: [
        target(reporter, "d1"),
        target(accused, "should-drop"),
      ],
      reviewerItems: [
        target(accused, "r-acc"),
        target("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "r1"),
        target(reporter, "r-self"),
      ],
      reporterUserUuid: reporter,
      accusedUserUuid: accused,
    });
    expect(selected.backup).toEqual([target(reporter, "d1")]);
    expect(selected.viewers).toEqual([target("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "r1")]);
  });

  it("caps distinct viewer accounts and keeps all devices of chosen accounts", () => {
    const users = [
      "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      "cccccccc-cccc-cccc-cccc-cccccccccccc",
      "dddddddd-dddd-dddd-dddd-dddddddddddd",
      "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
    ];
    const selected = selectFrankingSubmitWrapTargets({
      ownItems: [],
      reviewerItems: [
        target(users[0]!, "a1"),
        target(users[0]!, "a2"),
        target(users[1]!, "b1"),
        target(users[2]!, "c1"),
        target(users[3]!, "d1"),
        target(users[4]!, "e1"),
        target(users[5]!, "f1"),
      ],
      reporterUserUuid: reporter,
      accusedUserUuid: accused,
      maxViewerAccounts: 5,
    });
    expect(selected.viewers.map((item) => item.deviceUuid)).toEqual([
      "a1",
      "a2",
      "b1",
      "c1",
      "d1",
      "e1",
    ]);
  });
});

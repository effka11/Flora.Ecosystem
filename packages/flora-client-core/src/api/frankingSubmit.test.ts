import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./franking.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./franking.js")>();
  return {
    ...actual,
    apiGetFrankingWrapTargets: vi.fn(),
  };
});

import { apiGetFrankingWrapTargets } from "./franking.js";
import { loadFrankingSubmitWrapRoster } from "./frankingSubmit.js";

describe("loadFrankingSubmitWrapRoster", () => {
  beforeEach(() => {
    vi.mocked(apiGetFrankingWrapTargets).mockReset();
  });

  it("returns empty wraps when the roster fetch fails", async () => {
    vi.mocked(apiGetFrankingWrapTargets).mockRejectedValue(new Error("network"));
    await expect(loadFrankingSubmitWrapRoster()).resolves.toEqual({
      ownItems: [],
      reviewerItems: [],
    });
  });

  it("skips reviewer items when the roster is not ready", async () => {
    vi.mocked(apiGetFrankingWrapTargets).mockResolvedValue({
      items: [{ userUuid: "u", deviceUuid: "d", agreementPublicKeyBase64Url: "pk" }],
      ownItems: [{ userUuid: "me", deviceUuid: "d2", agreementPublicKeyBase64Url: "pk" }],
      reviewerRosterReady: false,
    });
    await expect(loadFrankingSubmitWrapRoster()).resolves.toEqual({
      ownItems: [{ userUuid: "me", deviceUuid: "d2", agreementPublicKeyBase64Url: "pk" }],
      reviewerItems: [],
    });
  });
});

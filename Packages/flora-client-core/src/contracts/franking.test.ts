import { describe, expect, it } from "vitest";
import {
  parseFrankingAudit,
  parseFrankingQueue,
  type FrankingReportMetaDto,
} from "./franking.js";

const REPORT_A: FrankingReportMetaDto = {
  reportUuid: "11111111-1111-1111-1111-111111111111",
  persistedMessageUuid: "22222222-2222-2222-2222-222222222222",
  conversationUuid: "33333333-3333-3333-3333-333333333333",
  category: "abuse",
  status: "open",
  claimedBy: null,
  claimedAt: null,
  createdAt: "2026-08-17T12:00:00.000Z",
  viewerAccountCount: 2,
  hasDisclosure: true,
  verificationStatus: "verifiable",
  reporterUsername: "alice",
  accusedUsername: "bob",
};

const REPORT_B: FrankingReportMetaDto = {
  reportUuid: "44444444-4444-4444-4444-444444444444",
  persistedMessageUuid: "55555555-5555-5555-5555-555555555555",
  conversationUuid: "66666666-6666-6666-6666-666666666666",
  category: "spam",
  status: "claimedAwaitingDisclosure",
  claimedBy: "77777777-7777-7777-7777-777777777777",
  claimedAt: "2026-08-17T13:00:00.000Z",
  createdAt: "2026-08-17T11:00:00.000Z",
  viewerAccountCount: 3,
  hasDisclosure: false,
  verificationStatus: "unverifiable",
  reporterUsername: null,
  accusedUsername: null,
};

describe("parseFrankingQueue", () => {
  it("parses a full queue page with pagination", () => {
    const page = parseFrankingQueue({
      items: [REPORT_A, REPORT_B],
      nextCursor: "opaque-cursor-1",
      hasMore: true,
    });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBe("opaque-cursor-1");
    expect(page.hasMore).toBe(true);
    expect(page.items[0]?.reportUuid).toBe(REPORT_A.reportUuid);
    expect(page.items[1]?.status).toBe("claimedAwaitingDisclosure");
  });

  it("parses reporter and accused usernames and treats missing as null", () => {
    const withoutNames = {
      reportUuid: REPORT_A.reportUuid,
      persistedMessageUuid: REPORT_A.persistedMessageUuid,
      conversationUuid: REPORT_A.conversationUuid,
      category: REPORT_A.category,
      status: REPORT_A.status,
      claimedBy: REPORT_A.claimedBy,
      claimedAt: REPORT_A.claimedAt,
      createdAt: REPORT_A.createdAt,
      viewerAccountCount: REPORT_A.viewerAccountCount,
      hasDisclosure: REPORT_A.hasDisclosure,
      verificationStatus: REPORT_A.verificationStatus,
    };
    const page = parseFrankingQueue({
      items: [REPORT_A, withoutNames],
      nextCursor: null,
      hasMore: false,
    });
    expect(page.items[0]?.reporterUsername).toBe("alice");
    expect(page.items[0]?.accusedUsername).toBe("bob");
    expect(page.items[1]?.reporterUsername).toBeNull();
    expect(page.items[1]?.accusedUsername).toBeNull();
  });

  it("handles explicit null for claimedBy, claimedAt, and nextCursor", () => {
    const page = parseFrankingQueue({
      items: [{ ...REPORT_A, claimedBy: null, claimedAt: null }],
      nextCursor: null,
      hasMore: false,
    });
    expect(page.items[0]?.claimedBy).toBeNull();
    expect(page.items[0]?.claimedAt).toBeNull();
    expect(page.nextCursor).toBeNull();
  });

  it("preserves camelCase status and audit event strings", () => {
    const page = parseFrankingQueue({
      items: [{ ...REPORT_B, status: "claimedAwaitingDisclosure" }],
      nextCursor: null,
      hasMore: false,
    });
    expect(page.items[0]?.status).toBe("claimedAwaitingDisclosure");

    const audit = parseFrankingAudit({
      viewerAccountCount: 1,
      events: [
        {
          auditUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          event: "wrapCreated",
          actorUserUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
          subjectUserUuid: null,
          createdAt: "2026-08-17T14:00:00.000Z",
        },
      ],
    });
    expect(audit.events[0]?.event).toBe("wrapCreated");
  });

  it("drops items with unknown status or missing reportUuid", () => {
    const page = parseFrankingQueue({
      items: [
        REPORT_A,
        { ...REPORT_B, status: "claimed_awaiting_disclosure" },
        { ...REPORT_A, reportUuid: "" },
        { ...REPORT_A, reportUuid: undefined },
      ],
      nextCursor: null,
      hasMore: false,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.reportUuid).toBe(REPORT_A.reportUuid);
  });

  it("returns empty page for non-object payload", () => {
    expect(parseFrankingQueue(null)).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
    expect(parseFrankingQueue("bad")).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
    });
  });
});

describe("parseFrankingAudit", () => {
  it("parses viewerAccountCount and events array", () => {
    const audit = parseFrankingAudit({
      viewerAccountCount: 4,
      events: [
        {
          auditUuid: "cccccccc-cccc-cccc-cccc-cccccccccccc",
          event: "claimed",
          actorUserUuid: "dddddddd-dddd-dddd-dddd-dddddddddddd",
          subjectUserUuid: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
          createdAt: "2026-08-17T15:00:00.000Z",
        },
        {
          auditUuid: "ffffffff-ffff-ffff-ffff-ffffffffffff",
          event: "released",
          actorUserUuid: "dddddddd-dddd-dddd-dddd-dddddddddddd",
          subjectUserUuid: null,
          createdAt: "2026-08-17T16:00:00.000Z",
        },
      ],
    });
    expect(audit.viewerAccountCount).toBe(4);
    expect(audit.events).toHaveLength(2);
    expect(audit.events[0]?.subjectUserUuid).toBe("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee");
    expect(audit.events[1]?.subjectUserUuid).toBeNull();
  });
});

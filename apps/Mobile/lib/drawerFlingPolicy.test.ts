import { describe, expect, it } from "vitest";
import {
  eligibleVerticalFling,
  shouldIssueVerticalFlingResume,
} from "./drawerFlingPolicy";

describe("drawer fling fallback policy", () => {
  it("resumes only a recent recorded coast with meaningful velocity", () => {
    expect(eligibleVerticalFling(101, 800, 900, 1000)).toBe(true);
    expect(eligibleVerticalFling(101, -800, 900, 1000)).toBe(true);
    expect(eligibleVerticalFling(101, 800, 650, 1000)).toBe(true);
    expect(eligibleVerticalFling(0, 800, 900, 1000)).toBe(false);
    expect(eligibleVerticalFling(101, 20, 900, 1000)).toBe(false);
    expect(eligibleVerticalFling(101, 800, 500, 1000)).toBe(false);
  });

  it("issues at most one resume for a captured edge gesture", () => {
    let issued = false;

    expect(shouldIssueVerticalFlingResume(issued, true)).toBe(true);
    issued = true;
    expect(shouldIssueVerticalFlingResume(issued, true)).toBe(false);
    expect(shouldIssueVerticalFlingResume(false, false)).toBe(false);
  });
});

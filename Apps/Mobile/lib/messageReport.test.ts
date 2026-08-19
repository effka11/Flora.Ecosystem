import { describe, expect, it } from "vitest";

import { frankingReportUserError } from "./messageReport";

describe("frankingReportUserError", () => {
  it("prefers Error.message over the generic fallback", () => {
    expect(frankingReportUserError(new Error("Сообщение не найдено."))).toBe(
      "Сообщение не найдено.",
    );
    expect(frankingReportUserError({ message: "btoa is not defined" })).toBe("btoa is not defined");
    expect(frankingReportUserError("nope")).toBe("Не удалось отправить жалобу.");
  });
});

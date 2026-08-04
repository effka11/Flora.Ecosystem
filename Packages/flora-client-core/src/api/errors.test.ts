import { describe, expect, it } from "vitest";
import { ApiRequestError, parseApiErrorBody } from "./errors.js";

describe("parseApiErrorBody", () => {
  it("extracts message and stable code", () => {
    const parsed = parseApiErrorBody(
      { error: "Неверный код.", code: "auth.password_reset.invalid_code" },
      401,
    );
    expect(parsed.message).toBe("Неверный код.");
    expect(parsed.code).toBe("auth.password_reset.invalid_code");
  });

  it("accepts PascalCase Code", () => {
    const parsed = parseApiErrorBody({ Error: "x", Code: "auth.password_reset.expired" }, 401);
    expect(parsed.message).toBe("x");
    expect(parsed.code).toBe("auth.password_reset.expired");
  });

  it("omits code when absent", () => {
    const parsed = parseApiErrorBody({ error: "boom" }, 500);
    expect(parsed.message).toBe("boom");
    expect(parsed.code).toBeUndefined();
  });
});

describe("ApiRequestError", () => {
  it("stores optional code", () => {
    const err = new ApiRequestError(429, "too many", "auth.password_reset.rate_limited");
    expect(err.status).toBe(429);
    expect(err.message).toBe("too many");
    expect(err.code).toBe("auth.password_reset.rate_limited");
  });
});

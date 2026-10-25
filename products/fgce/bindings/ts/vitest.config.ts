import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["bindings/ts/test/**/*.test.ts"],
    environment: "node",
  },
});

import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "../../Products/FSCP/ts/src/**/*.test.ts"],
    environment: "node",
    server: {
      deps: {
        inline: ["libsodium-wrappers", "libsodium"],
      },
    },
  },
  resolve: {
    alias: {
      "@flora/client-core": path.resolve(here, "src"),
      "@flora/fscp": path.resolve(here, "../../Products/FSCP/ts/src/index.ts"),
    },
  },
});

import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    server: {
      deps: {
        inline: ["libsodium-wrappers", "libsodium"],
      },
    },
  },
  resolve: {
    alias: {
      "@flora/client-core": path.resolve(root, "../../../Packages/flora-client-core/src"),
    },
  },
});

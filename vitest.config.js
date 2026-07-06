import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Server tests live next to sources; UI tests cover pure modules only
    // (layout functions etc.) — components are exercised in the browser.
    include: ["server/**/*.test.js", "ui/src/**/*.test.js"],
  },
});

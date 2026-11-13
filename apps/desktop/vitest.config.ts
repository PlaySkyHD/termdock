import { defineConfig } from "vitest/config";

export default defineConfig({
  // The renderer logic under test is DOM-free (TerminalController with a fake surface), so Node is enough.
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});

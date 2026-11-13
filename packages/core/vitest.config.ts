// The WSL integration tests share the tmux socket `termdock-test` and remove all `td-*` sessions on it after
// each test, so their files must not run in parallel. Unit tests keep running in parallel.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { fileParallelism: process.env.TERMDOCK_WSL_TESTS !== "1" },
});

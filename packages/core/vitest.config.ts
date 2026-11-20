// Each WSL integration test file has a tmux socket of its own (`src/test/wsl-socket.ts`, #147), so parallel runs in
// other worktrees do not disturb it. Within one run the files still run one after another to keep the load on WSL
// low. Unit tests run in parallel.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { fileParallelism: process.env.TERMDOCK_WSL_TESTS !== "1" },
});

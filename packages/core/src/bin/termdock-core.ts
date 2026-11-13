#!/usr/bin/env node
// Entry point `termdock-core` (ADR 0001): occupies the per-user pipe or exits with `already_running`.
// TERMDOCK_PIPE and TERMDOCK_TMUX_SOCKET isolate a core, e.g. for the desktop screenshot mode (ADR 0006);
// TERMDOCK_DATA_DIR is read by the storage itself.
import { runCore } from "./run-core.js";

const pipePath = process.env["TERMDOCK_PIPE"] || undefined;
const tmuxSocket = process.env["TERMDOCK_TMUX_SOCKET"] || undefined;

const result = await runCore({
  onExit: (code) => process.exit(code),
  ...(pipePath === undefined ? {} : { pipePath }),
  ...(tmuxSocket === undefined ? {} : { tmuxSocket }),
});
if (result.exitCode !== 0) process.exit(result.exitCode);

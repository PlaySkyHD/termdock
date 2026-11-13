#!/usr/bin/env node
// Entry point `termdock-core` (ADR 0001): occupies the per-user pipe or exits with `already_running`.
import { runCore } from "./run-core.js";

const result = await runCore({ onExit: (code) => process.exit(code) });
if (result.exitCode !== 0) process.exit(result.exitCode);

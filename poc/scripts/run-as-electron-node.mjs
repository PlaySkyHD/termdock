// Startet ein Skript mit dem Node von Electron (ELECTRON_RUN_AS_NODE=1), so wie ADR 0001 den Core
// starten will. Damit lässt sich prüfen, ob node-pty auch unter Electrons Node-ABI lädt.
// Aufruf: node scripts/run-as-electron-node.mjs <skript> [argumente...]
import { spawnSync } from "node:child_process";
import electronPath from "electron";

const result = spawnSync(electronPath, process.argv.slice(2), {
  stdio: "inherit",
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
});
process.exit(result.status ?? 1);

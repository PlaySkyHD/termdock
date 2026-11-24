# TermDock

Windows-Desktop-App zur Verwaltung langlebiger Terminal-Sessions (WSL-first, tmux) und projektbezogener Workspaces. Konzept: `docs/concept/v1-konzept.txt`. Architektur: `docs/adr/`.

## Vor dem ersten Schritt

- `docs/agent-lessons-learned.md` lesen (Worktrees unter `P:/GitHub/termdock-wt/`, WSL-Fallstricke, Merge-Ablauf). In jeden Subagent-Prompt einen Verweis darauf aufnehmen.
- Regeln: `.agents/instructions/` (`typescript`, `security`; `code-review` nur beim Review).
- Ablauf: OpenSpec-Change → Umsetzung mit Tests → `code-review` → PR → `retro`. Mehrere Issues: Skill `orchestrate-issues`.

## graphify

- `graphify-out/` ist gitignored. Fehlt `graphify-out/graph.json`, zuerst `graphify update .` ausführen (nur AST, keine API-Kosten).
- Gibt es den Graphen, vor dem ersten grep `graphify query "<frage>"` nutzen; `graphify path "<A>" "<B>"` für Beziehungen.
- Nach Codeänderungen `graphify update .`.

## Befehle

- `npm ci`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test -w packages/<name>`.
- Lasttest (#134, nur lokal, braucht WSL und den Core-Build `packages/core/dist` aus `npm run typecheck`): `node scripts/load-test.mjs`. Unter Electron wie im Paket (ADR 0007): im Worktree einmal `unset ELECTRON_RUN_AS_NODE && node_modules/.bin/electron --version` (lädt ein fehlendes `electron.exe` nach), dann `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe scripts/load-test.mjs`. Er nutzt einen eigenen Socket und einen temporären Datenordner.
- WSL-Integrationstests: `TERMDOCK_WSL_TESTS=1 npm test -w packages/core`.
- Desktop-App (ADR 0006): `npm start -w apps/desktop`; Screenshots gegen einen isolierten Core: `npm run screenshot -w apps/desktop -- <dir>`. In Agent-Shells vorher `unset ELECTRON_RUN_AS_NODE`.
- Installer (ADR 0007): `npm run dist -w apps/desktop` baut nach `apps/desktop/release/`; Prüfmodus der entpackten App (vorher `unset ELECTRON_RUN_AS_NODE`): `TERMDOCK_DATA_DIR=<temp-ordner> apps/desktop/release/win-unpacked/TermDock.exe --smoke-test`.
- Für eine Szenengruppe `npm run screenshot -w apps/desktop -- <dir> --scenes <gruppe>` (`scenario`, `sidebar`, `tabs`, `snap`, `restore`, `quit`, `search`, `settings`, `cwd`, `windows`, `crash`, `restart`; mehrere mit Komma); vor dem PR einmal den ganzen Lauf.

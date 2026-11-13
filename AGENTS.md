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
- WSL-Integrationstests: `TERMDOCK_WSL_TESTS=1 npm test -w packages/core`.
- Desktop-App (ADR 0006): `npm start -w apps/desktop`; Screenshots gegen einen isolierten Core: `npm run screenshot -w apps/desktop -- <dir>`. In Agent-Shells vorher `unset ELECTRON_RUN_AS_NODE`.

<img src="assets/icon.svg" width="64" height="64" alt="">

# TermDock

Persistent workspace and terminal manager for Windows. WSL-first, CLI-native.

TermDock keeps long-running terminal sessions (WSL via tmux, optional Windows shells) organized in project workspaces, with tabs, split panes, multiple windows and full layout restore. Claude Code, Codex and other CLIs run as ordinary programs in launch profiles; TermDock ships no agent runtime of its own.

- Concept (German): [`docs/concept/v1-konzept.txt`](docs/concept/v1-konzept.txt), [PDF](docs/concept/TermDock_V1_Konzept_und_Architektur.pdf)
- Architecture decisions: [`docs/adr/`](docs/adr/)
- Specs: [`openspec/specs/`](openspec/specs/)

## Status

V1 in development. Phase 0 (proof of concept) and Phase 1 (core system) first.

## Development

Requires Windows 11, Node 22.5+, and for the WSL backend a WSL distribution with tmux.

```sh
npm ci
npm run typecheck && npm run lint && npm test
```

Contributor and agent workflow: [`AGENTS.md`](AGENTS.md).

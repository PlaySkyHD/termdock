# Lessons Learned für Agents

Erkenntnisse aus dem Aufbau von TermDock. Übernommen sind die allgemeinen Regeln aus dem Gainer-Flow, ergänzt um Windows-, WSL- und Terminal-Fallstricke. Jeder Agent, der in diesem Repo arbeitet oder Subagents steuert, liest diese Datei vor dem ersten Schritt.

## 1. Host, Subagents und Worktrees

- **Host ist Windows 11.** Die Shell für Agents ist Git Bash (POSIX) oder PowerShell 5.1. Laufwerk `P:` ist in Git Bash `/p/`.
- **Haupt-Checkout:** `P:/GitHub/termdock`. Er bleibt auf `main` und wird nur vom Orchestrator geändert (`git pull --ff-only`).
- **Worktrees liegen unter `P:/GitHub/termdock-wt/<branch>`**, nie unter `C:`. Einrichten mit zwei einzelnen Befehlen: `git -C P:/GitHub/termdock fetch origin`, dann `git -C P:/GitHub/termdock worktree add P:/GitHub/termdock-wt/<branch> -b <branch> origin/main`. Danach nur im Worktree mit absoluten Pfaden arbeiten. Das Arbeitsverzeichnis wird zwischen Aufrufen zurückgesetzt: Prüfungen als ein Aufruf `cd P:/GitHub/termdock-wt/<branch> && npm test -w packages/core`.
- **Gestapelte Arbeit:** Worktree auf `origin/<parent-branch>` statt `origin/main` anlegen.
- **Gemeinsame Bausteine zuerst, dann parallel.** Domänentypen (`packages/protocol/src/model.ts`) und die Backend-Schnittstelle (`packages/core/src/backend/types.ts`) ändert nur der Orchestrator auf `main` oder ein ausdrücklich beauftragter Agent.
- **Ein Agent pro Paket.** Zwei Agents im selben Paket nur mit exakten Ankern.
- **„Fertig“ ist nicht geprüft.** Jedes Agent-Ergebnis vor dem PR selbst prüfen: `npm run typecheck`, `npm run lint`, Tests der betroffenen Pakete.
- **Modellwahl:** steht im Skill `orchestrate-issues`, Abschnitt 2.
- **API-Limit (`rate_limit`):** Nach der Reset-Zeit per `SendMessage` an dieselbe Agent-ID fortsetzen, keinen neuen Agent starten. Vorher `git -C <worktree> status` prüfen.
- **Pro Orchestrierungsrunde eine Session.** Nach dem Merge aller PRs eine Übergabe schreiben und im neuen Thread weitermachen.

## 2. WSL und tmux

- **WSL muss aktuell sein.** WSL 2.1.5 brach jeden Distro-Start mit `Wsl/Service/E_UNEXPECTED` ab; `wsl --update` (auf 3.0.5) behob es.
- **Distro:** `Ubuntu` (26.04), Standardbenutzer `nic`, tmux 3.6. Aufruf aus Windows: `wsl.exe -d Ubuntu -- <befehl>`.
- **Nicht aus einem Windows-Verzeichnis starten, das WSL nicht übersetzen kann.** Ein `wsl`-Aufruf aus einem unbekannten Arbeitsverzeichnis meldet `Failed to translate`. Im Code immer `--cd <linux-pfad>` oder `--cd ~` übergeben.
- **`wsl -l -v` gibt UTF-16 aus.** In Node `wsl.exe` mit `env: { WSL_UTF8: '1' }` aufrufen, sonst stehen Nullbytes zwischen den Zeichen.
- **Eigener tmux-Socket:** Produktiv `-L termdock`, Tests `-L termdock-test`. Tests räumen ihre Sessions mit `kill-session` auf; nie `kill-server` auf dem Produktiv-Socket.
- **WSL-Integrationstests** laufen nur mit `TERMDOCK_WSL_TESTS=1` und nur lokal; GitHub-Runner haben keine Distro.
- **`wsl.exe -- <args>` geht durch die Login-Shell** (`$HOME` wird expandiert, `;` trennt Befehle). Für Argument-Arrays `wsl.exe -d Ubuntu --cd ~ --exec <programm> ...` nutzen.
- **WSL beendet die Distro samt tmux-Server**, wenn ca. 8–20 s kein `wsl.exe`-Prozess läuft. Wer eine tmux-Session über eine Pause ohne PTY retten will, hält `wsl.exe -d Ubuntu --exec sleep infinity` offen (ADR 0003).
- **tmux: `status off` und `-T RGB`.** Ohne `status off` meldet `stty size` eine Zeile weniger als die PTY; ohne `-T RGB` am Client rechnet tmux Truecolor auf 256 Farben herunter. `status off` im selben Aufruf setzen (`new-session ... ; set-option -t <s> status off`), ein separates `set-option` direkt nach dem Start verliert das Rennen.

### node-pty und Electron (aus Phase 0, `docs/poc/phase-0-bericht.md`)

- **node-pty 1.1.0 bringt N-API-Prebuilds für `win32-x64` mit**; sie laden unter Node 25 und Electron 45 (auch mit `ELECTRON_RUN_AS_NODE=1`). Kein `@electron/rebuild` nötig, und es scheitert hier ohnehin (siehe nächster Punkt).
- **Bau aus dem Quelltext scheitert auf dem Host:** node-gyp 11 (npm-Bundle) kennt VS 2026 nicht (node-gyp ≥ 12 nötig), `GetCommitHash.bat` von winpty scheitert, solange `NoDefaultCurrentDirectoryInExePath=1` gesetzt ist, und MSBuild verlangt die Spectre-Bibliotheken (`MSB8040`). Prebuilds nicht mit `--build-from-source` entfernen.
- **`useConptyDll: true` setzen.** Mit der System-ConPTY wirft `kill()` im Hilfsprozess `conpty_console_list_agent` „AttachConsole failed“ auf stderr. Die mitgelieferte ConPTY fragt beim Start DA1 (`ESC [ c`) ab und wartet bis zu 3 s; xterm.js antwortet selbst, Node-Skripte ohne xterm müssen `ESC [ ? 1 ; 2 c` zurückschreiben.
- **Agent-Shells setzen `ELECTRON_RUN_AS_NODE=1`.** Electron startet dann als Node („does not provide an export named 'BrowserWindow'“). Vor `electron .` mit `unset ELECTRON_RUN_AS_NODE` starten.
- **tmux läuft selbst im Alternate Screen von xterm.js.** Ob eine TUI im Pane den Alternate Screen nutzt, nur über `tmux display-message -p '#{alternate_on}'` prüfen.

## 3. Tests

- Vitest, nur betroffene Pakete testen (`npm test -w packages/<name>`), die CI testet alles.
- Tests mit Prozessen, Pipes oder PTYs bauen alles in `afterEach` ab. Ein offener Handle lässt Vitest hängen.
- Für einen Bugfix zeigen, dass der neue Test ohne den Fix rot ist.

## 4. CI, PRs und Merge

- CI läuft auf `windows-latest` (Typecheck, Lint, Format, Unit-Tests) und prüft OpenSpec.
- `gh pr merge <n> --merge --delete-branch`, danach Worktree entfernen und `git pull --ff-only` im Haupt-Checkout.
- **Screenshots bei jeder sichtbaren UI-Änderung**, in PR und Issue. Aufnahme über den Screenshot-Modus der App (`--screenshot <dir>`, `webContents.capturePage()`), nicht per Bildschirmfoto des Hosts. Hochladen mit `bash scripts/attach-screenshots.sh pr|issue <n> <dateien…>`: Die Bilder liegen im Orphan-Branch `pr-assets` (nie auf `main`) und erscheinen als Kommentar.
- Nie `git restore`, `git stash` oder `git reset --hard`.

## 5. Agent-Konfiguration

- **Quelle ist `.agents/`.** Skills in `.agents/skills/<name>/SKILL.md`, Instructions in `.agents/instructions/`. `.claude/skills/<name>` und `.claude/rules/<name>.md` sind relative Symlinks darauf (`core.symlinks=true`, Windows-Entwicklermodus). Nie Kopien anlegen.
- **Neuer Skill:** in `.agents/skills/` anlegen, dann in Git Bash `MSYS=winsymlinks:nativestrict ln -s ../../.agents/skills/<name> .claude/skills/<name>`.
- **Retro nach jedem PR.** Nach `gh pr create` läuft der Skill `retro` (ein Hook erinnert daran). Findings werden Issues mit Label `agent-retro`, Fixes kommen in eigene PRs.
- **Host hat kein `jq` und kein `python3`.** Hooks sind Node-Skripte, Python läuft über `py -I`.

## 6. Arbeitsweise

- Jede Änderung als OpenSpec-Change (`npx openspec validate <change> --strict`), ein PR pro Thema, im selben PR archivieren (`npx openspec archive <change> -y`, danach `npx openspec validate --specs --strict`). Die CLI-Version steht in `tools/openspec/package.json`.
- Architekturentscheidungen stehen in `docs/adr/`. Weicht eine Umsetzung ab, wird das ADR im selben PR angepasst.
- Vor jedem Merge ein Code Review (`code-review <PR>`), Befunde beheben oder begründet verwerfen.
- Ursachen im Code belegen, bevor ein Fix gebaut wird.

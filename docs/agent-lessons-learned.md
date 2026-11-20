# Lessons Learned für Agents

Erkenntnisse aus dem Aufbau von TermDock. Übernommen sind die allgemeinen Regeln aus dem Gainer-Flow, ergänzt um Windows-, WSL- und Terminal-Fallstricke. Jeder Agent, der in diesem Repo arbeitet oder Subagents steuert, liest diese Datei vor dem ersten Schritt.

## 1. Host, Subagents und Worktrees

- **Host ist Windows 11.** Die Shell für Agents ist Git Bash (POSIX) oder PowerShell 5.1. Laufwerk `P:` ist in Git Bash `/p/`.
- **Haupt-Checkout:** `P:/GitHub/termdock`. Er bleibt auf `main` und wird nur vom Orchestrator geändert (`git pull --ff-only`).
- **Vor einem manuellen Test im Haupt-Checkout** (nach dem letzten `pull --ff-only`): zuerst mit dem PowerShell-Tool prüfen, ob TermDock aus dem Checkout läuft: `Get-Process | Where-Object { $_.Path -like 'P:\GitHub\termdock\*' }`. Auch nach dem Schließen der Fenster läuft der Core weiter (`electron.exe … termdock-core.js`) und sperrt `node_modules`; `npm ci` scheitert dann mit einem Rechtefehler und lässt `node_modules` halb gelöscht (PR #79). Den Nutzer fragen. Nur mit seinem OK den Core beenden, in dieser Reihenfolge:
  1. WSL wachhalten, sonst sterben seine tmux-Sessions (Abschnitt 2): Bash-Tool mit `run_in_background`: `wsl.exe -d Ubuntu --cd '~' --exec sleep infinity`.
  2. Core beenden (PowerShell): `Stop-Process -Id <pid> -Confirm:$false`; danach mit `wsl.exe -d Ubuntu --exec tmux -L termdock list-sessions` prüfen, dass die Sessions noch da sind.
  3. Den Keepalive-Task stoppen, sobald der neue Core läuft (er hält WSL dann selbst wach).
  Dann im Bash-Tool, je ein Aufruf: `cd P:/GitHub/termdock && npm ci`, danach die Probe `cd P:/GitHub/termdock && unset ELECTRON_RUN_AS_NODE && node_modules/.bin/electron --version && node -e "require('node-pty')"`. Sie lädt ein fehlendes `electron.exe` selbst nach; `npx electron` nicht verwenden, es lädt bei fehlendem Paket eine beliebige Version aus der Registry. Sonst scheitert `npm start -w apps/desktop` an fehlenden Modulen (`node-pty`, `electron`, `react`), weil alle Arbeit in Worktrees lief.
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
- **Nie `wsl --shutdown` oder `--terminate`** (auch nicht `wsl -t`): Das beendet den produktiven tmux-Server (Socket `termdock`) samt aller Sessions des Nutzers. Bei WSL-Fehlern (z. B. `E_FAIL`) stoppen und berichten.
- **Distro:** `Ubuntu` (26.04), Standardbenutzer `nic`, tmux 3.6. Aufruf aus Windows: `wsl.exe -d Ubuntu -- <befehl>`.
- **Nicht aus einem Windows-Verzeichnis starten, das WSL nicht übersetzen kann.** Ein `wsl`-Aufruf aus einem unbekannten Arbeitsverzeichnis meldet `Failed to translate`. Im Code immer `--cd <linux-pfad>` oder `--cd ~` übergeben.
- **`wsl -l -v` gibt UTF-16 aus.** In Node `wsl.exe` mit `env: { WSL_UTF8: '1' }` aufrufen, sonst stehen Nullbytes zwischen den Zeichen.
- **Eigener tmux-Socket:** Produktiv `-L termdock`; jede WSL-Testdatei und jeder Screenshot-Lauf der Desktop-App `-L termdock-test-<pid>-<nonce>` (parallele Läufe teilten sich sonst den Server und beendeten sich gegenseitig die Sessions). WSL-Tests nehmen den Socket aus `packages/core/src/test/wsl-socket.ts` (`wslTestSocket()`), nie den festen Namen `termdock-test` (ein Test prüft das); parallele Worktrees stören sich nicht. Tests räumen ihre Sessions mit `kill-session` auf und beenden am Ende nur den Server des eigenen Sockets (`killWslTestServer`); nie `kill-server` auf dem Produktiv-Socket.
- **Git Bash wandelt POSIX-Pfade in Argumenten nativer Programme um** (`wsl.exe --exec ls /tmp` bekommt `C:/…/Temp`). Manuelle Aufrufe mit `MSYS_NO_PATHCONV=1` starten, z. B. `MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu --cd ~ --exec ls /tmp`. Node-Code (`execFile`) ist nicht betroffen, PowerShell auch nicht.
- **tmux lässt die Socket-Datei liegen** (`/tmp/tmux-<uid>/<name>`), nach `kill-server` und nach einem hart beendeten Server; Suchen finden sie danach wieder und zählen sie erneut. Aufräumen heißt: erst den Server beenden (`tmux -L <name> kill-server`, nur für Läufe `termdock-test-<pid>-<nonce>`), dann die Datei selbst löschen (`rm -f -- <pfad>`). Der Screenshot-Lauf tut das für Sockets beendeter Läufe selbst (`cleanStaleSockets`, `wslSocketDeps` in `apps/desktop/src/main/screenshot.ts`); der Aufräumer der WSL-Tests (`packages/core/src/test/wsl-socket.ts`) beendet nur die Server beendeter Läufe, die Dateien bleiben liegen. Wer von Hand eine Datei zählt oder löscht, nimmt nur Sockets mit diesem Namensmuster, nie `termdock`.
- **WSL-Integrationstests** laufen nur mit `TERMDOCK_WSL_TESTS=1` und nur lokal; GitHub-Runner haben keine Distro.
- **`wsl.exe -- <args>` geht durch die Login-Shell** (`$HOME` wird expandiert, `;` trennt Befehle). Für Argument-Arrays `wsl.exe -d Ubuntu --cd ~ --exec <programm> ...` nutzen.
- **WSL beendet die Distro samt tmux-Server**, wenn ca. 8–20 s kein `wsl.exe`-Prozess läuft. Wer eine tmux-Session über eine Pause ohne PTY retten will, hält `wsl.exe -d Ubuntu --exec sleep infinity` offen (ADR 0003).
- **Der Keepalive des Core läuft losgelöst (#140):** `wsl.exe … tmux -L <socket> wait-for termdock-keepalive` überlebt den Kill des Core und endet mit dem tmux-Server; der nächste Core beendet ihn per `pkill` und startet seinen eigenen. Solche Prozesse auf dem Socket `termdock` gehören dem Nutzer, nie beenden. Kinder ohne `detached` liegen im Job-Objekt des Elternprozesses und sterben mit ihm.
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
- **Merge:** erst den Worktree entfernen, dann mergen. Die genaue Befehlsfolge steht im Skill `orchestrate-issues`, Abschnitt 5.
- **Screenshots bei jeder sichtbaren UI-Änderung**, in PR und Issue. Aufnahme über den Screenshot-Modus der App (`--screenshot <dir>`, `webContents.capturePage()`), nicht per Bildschirmfoto des Hosts. Mit `--scenes <gruppe,…>` läuft nur eine Szenengruppe (`scenario`, `sidebar`, `tabs`, `snap`, `restore`, `quit`, `search`, `settings`, `cwd`, `crash`, `restart`; jede bringt ihren Aufbau mit, ein unbekannter Name beendet den Lauf mit Code 1); die Arbeit an einer Szene prüft die Gruppe, Der volle Lauf kommt zuletzt: nach den Review-Fixes und nach dem letzten Merge von origin/main, direkt vor dem Push. Bis dahin genügt `--scenes <gruppe>`. Hochladen mit `bash scripts/attach-screenshots.sh pr|issue <n> <dateien…>`: Die Bilder liegen im Orphan-Branch `pr-assets` (nie auf `main`) und erscheinen als Kommentar. Eine neue Szenengruppe nimmt ein freies Präfix; Szenen in einer bestehenden Gruppe nehmen den nächsten freien Buchstaben an einem Präfix ihrer Datei (`19a-…`, `19b-…`). Alle Zehnerblöcke sind belegt (Stand PR #161): eine neue Gruppe nimmt freie Einzelpräfixe (z. B. `34`–`39`, `46`–`49`, `56`–`59`, `66`–`69`, `72`–`79`, `92`–`99`); vorher in den Szenendateien prüfen, was frei ist; `apps/desktop/src/main/scene-prefixes.test.ts` prüft eindeutige Präfixe.
- **Screenshot-Läufe sind unter Last wackelig (#127).** Der Lauf wiederholt eine gescheiterte Szenengruppe selbst genau einmal und loggt `retry <gruppe>: <fehler>`; die Zusammenfassung am Ende nennt alle Wiederholungen. Für den PR reicht `--scenes <betroffene gruppen>` plus ein voller Lauf. Scheitert der volle Lauf in einer fremden Gruppe, diese Gruppe einzeln mit `--scenes <gruppe>` wiederholen statt den vollen Lauf. Neue Szenen warten auf einen beobachtbaren Endzustand (Zeilen im Pane, Cursor aus tmux, neue `stty`-Antwort) mit Zeitlimit und Meldung, die den letzten Zustand nennt, nie auf eine feste Zeit oder ein einmaliges Lesen.
- **Läufe warten aufeinander (Sperre in `%TEMP%`); parallele Agents verlieren Zeit, aber keine Läufe (#144).** Ein Lauf legt vor seinem Core `%TEMP%/termdock-screenshot.lock` mit seiner PID an; ein zweiter loggt `waiting for screenshot run <pid>` und wartet höchstens 15 min (danach Code 1). Die Wartezeit zählt nicht ins Laufzeitlimit. Die Sperre eines beendeten Prozesses gilt als frei, die Datei nie von Hand löschen, solange ein Lauf lebt.
- **`UnknownVizError` aus `capturePage()`** in einer Szene, die der Diff nicht berührt, deutet auf GPU-Konkurrenz (Spiele, Videoexport) hin, nicht auf einen Fehler im Code (PR #114, #115). Den Nutzer fragen, ob GPU-lastige Programme laufen, danach den Lauf wiederholen; den Code nicht ändern. Screenshot-Läufe holen Fenster in den Vordergrund: Läuft beim Nutzer etwas im Vollbild, vorher fragen.
- **Screenshot-Fenster öffnen auf dem ersten Nebenmonitor**, nicht auf dem Hauptmonitor des Nutzers. `TERMDOCK_SCREENSHOT_DISPLAY=primary` oder `=<nummer>` (1-basiert, Reihenfolge von `screen.getAllDisplays()`) wählt einen anderen. Szenen positionieren Fenster relativ zum ersten Fenster, nie absolut (`screenshot-restore.ts`).
- Verbotene Befehle (u. a. `git restore`, `git stash`, `git reset --hard`): siehe Abschnitt 5.

## 5. Agent-Konfiguration

- **Quelle ist `.agents/`.** Skills in `.agents/skills/<name>/SKILL.md`, Instructions in `.agents/instructions/`. `.claude/skills/<name>` und `.claude/rules/<name>.md` sind relative Symlinks darauf (`core.symlinks=true`, Windows-Entwicklermodus). Nie Kopien anlegen.
- **Neuer Skill:** in `.agents/skills/` anlegen, dann in Git Bash `MSYS=winsymlinks:nativestrict ln -s ../../.agents/skills/<name> .claude/skills/<name>`.
- **Retro nach jedem PR.** Nach `gh pr create` läuft der Skill `retro` (ein Hook erinnert daran). Findings werden Issues mit Label `agent-retro`, Fixes kommen in eigene PRs.
- **Host hat kein `jq` und kein `python3`.** Hooks sind Node-Skripte, Python läuft über `py -I`.
- **Verbotene Befehle erzwingt der PreToolUse-Hook `.claude/hooks/guard-commands.mjs`** (Bash und PowerShell, Exit 2 mit Begründung und erlaubter Alternative). Er blockiert:
  - `git restore`, `git stash`, `git reset --hard` (auch mit `-C <pfad>` oder `-c k=v` davor);
  - tmux `kill-server` auf dem Socket `termdock` oder ohne `-L` (`-L termdock-test…` ist erlaubt, siehe Abschnitt 2);
  - `wsl --shutdown`, `wsl --terminate`, `wsl -t` (siehe Abschnitt 2);
  - `git push` im Haupt-Checkout `P:/GitHub/termdock` (cwd oder `-C`); gepusht wird nur aus dem eigenen Worktree (#128);
  - schreibende Shell-Befehle auf Dateien im Repo-Checkout oder einem Worktree (`P:/GitHub/termdock…` und relative Pfade): `sed -i`, `perl -i`, `node -e`/`-p` mit `writeFileSync` und Co., Umleitungen `>`/`>>`, `tee`, Heredocs in Dateien, `Set-Content`/`Out-File`/`Add-Content`;
  - `cp`, `mv`, `install` (und `Copy-Item`/`Move-Item`), wenn das Ziel (letztes Nicht-Options-Argument, `-t <dir>`, `--target-directory`, `-Destination`) im Repo-Checkout oder einem Worktree liegt. Kopien aus dem Repo nach `P:/Temp/` bleiben erlaubt.
  - Erlaubt bleiben Umleitungen nach `/dev/null`, `$null` und `P:/Temp/`, `git commit -F <datei>`, Formatter, Generatoren und `gh … --body-file`. Dateien ändern Agents mit Read, Edit und Write.
  - Der Hook prüft nur das Kommandowort jedes Teilbefehls und übersieht lieber etwas, als fälschlich zu blockieren. Bekannte Lücken stehen im Kopf des Skripts, u. a. Skriptdateien (`node x.mjs`, `bash x.sh`): Ihr Inhalt ist unbekannt, auch sie zählen als Schreiben per Shell und sind verboten. Er wirkt erst, wenn er im Haupt-Checkout liegt; Tests: `npm run test:hooks`.

## 6. Arbeitsweise

- Jede Änderung als OpenSpec-Change (`npx openspec validate <change> --strict`), ein PR pro Thema, im selben PR archivieren (`npx openspec archive <change> -y`, danach `npx openspec validate --specs --strict`). Die CLI-Version steht in `tools/openspec/package.json`.
- Architekturentscheidungen stehen in `docs/adr/`. Weicht eine Umsetzung ab, wird das ADR im selben PR angepasst.
- Vor jedem Merge ein Code Review (`code-review <PR>`), Befunde beheben oder begründet verwerfen. Den Worktree-Pfad immer im Argument nennen, sonst prüft der geforkte Review womöglich einen anderen Klon (Skill `orchestrate-issues`, Abschnitte 3 und 5).
- Ursachen im Code belegen, bevor ein Fix gebaut wird.
- **Videos des Nutzers (mp4, webm): `scripts/video-frames.cjs`, Bilder danach mit Read ansehen.** Der Host hat kein ffmpeg; das Skript speichert mit dem Electron aus `node_modules` Einzelbilder: `unset ELECTRON_RUN_AS_NODE`, dann `node_modules/electron/dist/electron.exe scripts/video-frames.cjs <video> P:/Temp/<ordner> <sekunden-abstand>` (schreibt `f-<sekunden>.png`, höchstens 300 Bilder; bei langen Videos einen größeren Abstand wählen). Fehlt `electron.exe` im Worktree, lädt es die Probe aus Abschnitt 1 nach. Video und Bilder gehören nicht ins Repo.
- **`git push` ist ein eigener Befehl.** Davor die Ausgabe von Checks, Merge und Screenshot-Lauf lesen; nie `… && git push` oder `…; git push` an Checks, Merge oder `cd` hängen (PRs #124–#126). Bei `| tail` den Exit-Code mit `set -o pipefail` oder `${PIPESTATUS[0]}` prüfen.

# V1-Abnahme

Nachweis der 15 V1-Abnahmekriterien aus `docs/concept/v1-konzept.txt`, Abschnitt 10 (Issue #132). Je Kriterium steht hier, welcher automatische Test, welche Screenshot-Szene oder welcher manuelle Schritt es belegt.

## Regeln

- Ein Test, der ein Kriterium belegt, trägt im Namen das Präfix `[V1-<nn>]`, z. B. `it("[V1-09] …")`. Belegt er mehrere, stehen alle Präfixe vorne (`[V1-01][V1-02] …`).
- `node scripts/acceptance-check.mjs` prüft diese Datei, auch in der CI: Jedes Kriterium hat einen Abschnitt mit dem Text des Konzepts und eine Zeile in der Übersicht mit demselben Status; jedes Kriterium außer einem offenen hat mindestens einen Nachweis; jede genannte Datei existiert und enthält den genannten Testnamen bzw. die Szene; jeder Test mit `[V1-<nn>]` in `packages/` und `apps/` steht unter seinem Kriterium.
- Status: `automatisiert` (nur Tests und Szenen), `automatisiert und manuell` (zusätzlich ein Schritt, den kein Test abdeckt), `manuell`, `offen, #<issue>`.
- Nachweise stehen als Liste unter `Status:`, je Zeile einer in dieser Form:

```text
- Test `<datei>`: `<testname>`
- Szene `<datei>` (Gruppe `<gruppe>`): `<bild>.png`
- Manuell: <schritt und erwartetes Ergebnis>
```

## Ausführen

- Unit-Tests: `npm test -w packages/core`, `npm test -w apps/desktop` (laufen in der CI).
- WSL-Tests (`*.wsl.test.ts`, nur lokal, Ubuntu mit tmux und vim): `TERMDOCK_WSL_TESTS=1 npm test -w packages/core`. Jede Testdatei nutzt ihren eigenen tmux-Socket (`packages/core/src/test/wsl-socket.ts`), nie `termdock`.
- Screenshot-Szenen (nur lokal): `unset ELECTRON_RUN_AS_NODE`, dann `npm run screenshot -w apps/desktop -- <dir> --scenes <gruppe>`. Ein Lauf endet mit Code 1, wenn ein erwarteter Zustand nicht eintritt; die Bilder prüft ein Mensch.
- Manuelle Schritte: mit der installierten App oder `npm start -w apps/desktop` und einem echten WSL.

## Übersicht

| Nr  | Kriterium                                                                                  | Status                    |
| --- | ------------------------------------------------------------------------------------------ | ------------------------- |
| 01  | Workspace mit mehreren Projektordnern anlegen und öffnen.                                  | automatisiert             |
| 02  | Neue WSL-Shell startet im erwarteten Arbeitsverzeichnis.                                   | automatisiert             |
| 03  | Claude Code/Codex funktioniert als interaktive CLI in einem Startprofil.                   | automatisiert und manuell |
| 04  | Tabwechsel lässt die Session und den Prozess aktiv.                                        | automatisiert und manuell |
| 05  | Dieselbe Session kann in zwei Fenstern angezeigt werden; nur eine Ansicht sendet Eingaben. | automatisiert             |
| 06  | 2–4 Split-Panes verhalten sich korrekt bei Resize.                                         | automatisiert             |
| 07  | Nur markierte Autostart-Profile werden automatisch ausgeführt.                             | automatisiert             |
| 08  | Workspace-, Tab- und Split-Layout wird beim UI-Neustart wiederhergestellt.                 | automatisiert             |
| 09  | Abgebrochene WSL-Sessions werden als Interrupted markiert.                                 | automatisiert             |
| 10  | Archivieren beendet den Prozess und erhält den zulässigen Verlauf.                         | automatisiert             |
| 11  | Das Speicherlimit für History greift auch bei hoher Terminalausgabe.                       | automatisiert             |
| 12  | Gruppenlose Sessions lassen sich anlegen, verschieben, archivieren und löschen.            | automatisiert             |
| 13  | Der Schließen-Dialog bietet verständliche Optionen zum Session-Lifecycle.                  | automatisiert und manuell |
| 14  | Mehrere UI-Fenster verursachen weder doppelte Sessions noch doppelte Autostarts.           | automatisiert und manuell |
| 15  | Windows-Shells funktionieren mit erkennbaren Persistenzgrenzen.                            | automatisiert und manuell |

## Kriterien

### V1-01: Workspace mit mehreren Projektordnern anlegen und öffnen.

Status: automatisiert

- Test `packages/core/src/ipc/ipc.test.ts`: `[V1-01] creates, renames and lists workspaces and projects`
- Test `packages/core/src/storage/workspace-repository.test.ts`: `[V1-01] keeps workspaces and projects over a restart`
- Test `apps/desktop/src/renderer/commands.test.ts`: `[V1-01] creates the session in the project directory and opens it by the mode of the click`
- Test `packages/core/src/e2e.wsl.test.ts`: `[V1-01][V1-02] starts a session from a profile in the directory of its project, command as argument array (issue #58)`
- Szene `apps/desktop/src/main/screenshot-sidebar.ts` (Gruppe `sidebar`): `80-sidebar-workspaces.png`
- Szene `apps/desktop/src/main/screenshot-sidebar.ts` (Gruppe `sidebar`): `88-project-session.png`

### V1-02: Neue WSL-Shell startet im erwarteten Arbeitsverzeichnis.

Status: automatisiert

- Test `packages/core/src/backend/wsl/backend.wsl.test.ts`: `[V1-02] starts in the requested directory within 3 s, echoes input and follows resizes`
- Test `packages/core/src/e2e.wsl.test.ts`: `[V1-01][V1-02] starts a session from a profile in the directory of its project, command as argument array (issue #58)`
- Test `packages/core/src/workspace/default-cwd.test.ts`: `[V1-02] prefers project, then workspace, then setting, then the home directory`
- Szene `apps/desktop/src/main/screenshot-cwd.ts` (Gruppe `cwd`): `70-cwd-missing-warning.png`

### V1-03: Claude Code/Codex funktioniert als interaktive CLI in einem Startprofil.

Status: automatisiert und manuell

Der WSL-Test startet `vim` aus einem Startprofil als Stellvertreter für ein interaktives Vollbildprogramm: Alternate Screen (über `#{alternate_on}` von tmux), getippter Text auf dem Schirm und in der Ausgabe der View, Ende mit Exit-Code 0 und gespeicherter Datei.

- Test `packages/core/src/e2e.wsl.test.ts`: `[V1-03] runs vim from a profile: alternate screen, typed text on the screen and in the view, clean exit`
- Szene `apps/desktop/src/main/screenshot-scenario.ts` (Gruppe `scenario`): `12-vim-before.png`
- Manuell: In den Einstellungen je ein Startprofil mit Befehl `claude` und `codex` (Argument je Zeile, Verzeichnis eines Projekts) anlegen, daraus eine Session starten, eine Frage stellen, die Antwort mit Farben lesen, eine Rückfrage mit den Pfeiltasten beantworten, das Fenster verkleinern (die CLI zeichnet neu) und die CLI mit ihrem Befehl beenden. Erwartet: keine kaputten Zeichen, Eingabe kommt an, die Session ist danach `Exited`.

### V1-04: Tabwechsel lässt die Session und den Prozess aktiv.

Status: automatisiert und manuell

Der Renderer hängt je Pane eine View ein, Schlüssel ist die Pane-ID; eine View trennt sich (`detach`) nur, wenn ihre Pane verschwindet oder eine andere Session zeigt. Der erste Test schaltet mit allen Tab-Befehlen und per Klick um und prüft auf Ebene des Modells: Das Layout nennt dieselben Panes mit denselben Sessions, die Tab-Befehle rufen den Core nicht auf, alle Sessions bleiben `Running`. Dass `PaneTree` die Views dabei wirklich nicht aushängt, prüft er nicht (kein gerendertes React). Der zweite Test ist nur die Voraussetzung (`layoutWindow` liefert auch die Panes inaktiver Tabs). Den eigentlichen Nachweis, dass View und Prozess weiterlaufen, liefert der manuelle Schritt.

- Test `apps/desktop/src/renderer/commands.test.ts`: `[V1-04] switches tabs without unmounting a pane or reaching the core: same views, sessions stay Running`
- Test `apps/desktop/src/renderer/pane-layout.test.ts`: `[V1-04] lists the panes of every tab, tabs in order and each in tree order, with their tab`
- Manuell: In Tab 1 `while :; do date +%T; sleep 1; done` starten, 30 s in Tab 2 arbeiten, zurück zu Tab 1. Erwartet: Die Uhrzeiten laufen ohne Lücke weiter, die Statusleiste zeigt weiter `Running`, `wsl.exe -d Ubuntu --exec tmux -L termdock list-panes -a -F '#{session_name} #{pane_pid}'` nennt vor und nach dem Wechsel dieselbe PID.

### V1-05: Dieselbe Session kann in zwei Fenstern angezeigt werden; nur eine Ansicht sendet Eingaben.

Status: automatisiert

- Test `packages/core/src/session/registry.test.ts`: `[V1-05] lets only the first view write when two views are attached`
- Test `packages/core/src/ipc/ipc.test.ts`: `[V1-05] gives the first view the writer role, only the writer may input and resize`
- Test `apps/desktop/src/renderer/terminal-controller.test.ts`: `[V1-05] as reader drops input and automatic replies and shows the writer's size`
- Szene `apps/desktop/src/main/screenshot-scenario.ts` (Gruppe `scenario`): `05-reader.png`
- Szene `apps/desktop/src/main/screenshot-scenario.ts` (Gruppe `scenario`): `07b-reader-after-take-input.png`

### V1-06: 2–4 Split-Panes verhalten sich korrekt bei Resize.

Status: automatisiert

- Test `apps/desktop/src/renderer/ui-store.test.ts`: `[V1-06] refuses a fifth pane and leaves the tab unchanged`
- Test `apps/desktop/src/renderer/ui-store.test.ts`: `[V1-06] moves a divider between two children and keeps the sum of the shares`
- Test `apps/desktop/src/renderer/terminal-controller.test.ts`: `[V1-06] as writer follows a smaller area and sends the new size once`
- Test `packages/core/src/session/registry.test.ts`: `[V1-06] resizes the PTY only for the writer and reports the size to all views`
- Szene `apps/desktop/src/main/screenshot-scenario.ts` (Gruppe `scenario`): `08-two-panes-stty-before.png`
- Szene `apps/desktop/src/main/screenshot-scenario.ts` (Gruppe `scenario`): `09-two-panes-stty-after.png`
- Szene `apps/desktop/src/main/screenshot-scenario.ts` (Gruppe `scenario`): `10-three-panes.png`
- Szene `apps/desktop/src/main/screenshot-scenario.ts` (Gruppe `scenario`): `11-four-panes.png`

### V1-07: Nur markierte Autostart-Profile werden automatisch ausgeführt.

Status: automatisiert

- Test `packages/core/src/session/autostart.test.ts`: `[V1-07] starts exactly the profiles marked autostart, with name, workspace, logging and launch of the profile`
- Test `packages/core/src/bin/run-core.test.ts`: `[V1-07] starts exactly the autostart profiles, and a restart with running sessions starts none`
- Test `packages/core/src/autostart.wsl.test.ts`: `[V1-07] starts an autostart profile once and re-attaches it after a Core restart`

### V1-08: Workspace-, Tab- und Split-Layout wird beim UI-Neustart wiederhergestellt.

Status: automatisiert

- Test `apps/desktop/src/renderer/layout-mapping.test.ts`: `[V1-08] restores tabs, pane tree, shares and active ids of the store`
- Test `apps/desktop/src/renderer/layout-mapping.test.ts`: `[V1-08] restores two windows with their own tabs`
- Test `apps/desktop/src/main/layout-coordinator.test.ts`: `[V1-08] returns the windows of the stored layout and remembers its revision`
- Test `packages/core/src/bin/run-core.test.ts`: `[V1-08] keeps the layout and its revision across a restart and holds layout.get until the reconcile is done`
- Szene `apps/desktop/src/main/screenshot-restore.ts` (Gruppe `restore`): `15-layout-before-window-1.png`
- Szene `apps/desktop/src/main/screenshot-restore.ts` (Gruppe `restore`): `17-layout-restored-window-1.png`

### V1-09: Abgebrochene WSL-Sessions werden als Interrupted markiert.

Status: automatisiert

- Test `packages/core/src/e2e.wsl.test.ts`: `[V1-09] survives a core restart and reports a session killed from outside as Interrupted`
- Test `packages/core/src/session/restore.test.ts`: `[V1-09] makes a WSL session whose tmux session is gone Interrupted`
- Test `packages/core/src/session/restore.test.ts`: `[V1-09] makes WSL sessions Interrupted and reports backend_unavailable when WSL is not available`
- Test `packages/core/src/failure.wsl.test.ts`: `[V1-09] makes every session Interrupted, tells the attached views and leaves no PTY behind`
- Test `packages/core/src/failure.wsl.test.ts`: `[V1-09] starts an Interrupted session again after the server died, with its view as writer`
- Test `packages/core/src/bin/failure-scenarios.test.ts`: `[V1-09] makes the stored sessions Interrupted and reports backend_unavailable without touching WSL`
- Test `apps/desktop/src/renderer/session-display.test.ts`: `[V1-09] warns about each backend the core could not reach`
- Szene `apps/desktop/src/main/screenshot-scenario.ts` (Gruppe `scenario`): `04-interrupted-notice.png`
- Szene `apps/desktop/src/main/screenshot-restore.ts` (Gruppe `restore`): `18-layout-restored-window-2-interrupted.png`

### V1-10: Archivieren beendet den Prozess und erhält den zulässigen Verlauf.

Status: automatisiert

- Test `packages/core/src/session/session-management.test.ts`: `[V1-10] ends a running process, archives the session and does not remove its history`
- Test `packages/core/src/ipc/session-management.test.ts`: `[V1-10] archives a running session: process ended, Archived reported, history kept`
- Test `packages/core/src/session-management.wsl.test.ts`: `[V1-10] archives a running session: tmux session gone, history kept; then deletes it with its history`
- Szene `apps/desktop/src/main/screenshot-sidebar.ts` (Gruppe `sidebar`): `81-sidebar-archive-open.png`

### V1-11: Das Speicherlimit für History greift auch bei hoher Terminalausgabe.

Status: automatisiert

- Test `packages/core/src/storage/history-store.test.ts`: `[V1-11] changes segments at limit / 2, never exceeds the limit and keeps at least limit / 2 of the newest output`
- Test `packages/core/src/storage/history-store.test.ts`: `[V1-11] holds the limit under 50 MiB of output while the PTY keeps flowing (issue #59)`
- Test `packages/core/src/e2e.wsl.test.ts`: `[V1-11] holds the history limit under 50 MiB of output and keeps the PTY flowing (issue #59)`
- Test `packages/core/src/bin/hard-kill.test.ts`: `[V1-11] leaves a readable database, a readable history within the limit and no half-saved layout`
- Szene `apps/desktop/src/main/screenshot-settings.ts` (Gruppe `settings`): `61-settings-history.png`

### V1-12: Gruppenlose Sessions lassen sich anlegen, verschieben, archivieren und löschen.

Status: automatisiert

- Test `packages/core/src/session-management.wsl.test.ts`: `[V1-12] creates a session without group, moves it into a workspace and back, archives and deletes it`
- Test `packages/core/src/session/session-management.test.ts`: `[V1-12] moves a session to ungrouped and back into a workspace`
- Test `packages/core/src/ipc/session-management.test.ts`: `[V1-12] deletes a session with its views, history and stored row and sends session.removed`
- Test `apps/desktop/src/renderer/sidebar-model.test.ts`: `[V1-12] puts sessions without workspace under the ungrouped section`
- Szene `apps/desktop/src/main/screenshot-sidebar.ts` (Gruppe `sidebar`): `83-drag-drop-done.png`
- Szene `apps/desktop/src/main/screenshot-sidebar.ts` (Gruppe `sidebar`): `85-delete-confirm.png`

### V1-13: Der Schließen-Dialog bietet verständliche Optionen zum Session-Lifecycle.

Status: automatisiert und manuell

- Test `apps/desktop/src/shared/quit-decision.test.ts`: `[V1-13] asks while sessions run and the question is on`
- Test `apps/desktop/src/shared/quit-decision.test.ts`: `[V1-13] keeps or stops the sessions without storing when the checkbox is off`
- Test `apps/desktop/src/main/quit-flow.test.ts`: `[V1-13] asks with the number of running sessions and keeps them on that choice`
- Test `apps/desktop/src/main/quit-flow.test.ts`: `[V1-13][V1-15] tells the dialog how many of the running sessions are Windows shells (#65)`
- Test `apps/desktop/src/shared/quit-decision.test.ts`: `[V1-13][V1-15] says that Windows shells run only as long as the core does`
- Szene `apps/desktop/src/main/screenshot-scenario.ts` (Gruppe `quit`): `24-quit-dialog.png`
- Szene `apps/desktop/src/main/screenshot-windows.ts` (Gruppe `windows`): `37-windows-quit-dialog.png`
- Szene `apps/desktop/src/main/screenshot-scenario.ts` (Gruppe `quit`): `25-quit-dialog-do-not-ask-again.png`
- Manuell: Mit zwei laufenden Sessions die App beenden und den Dialog lesen. Erwartet: Er nennt die Zahl der laufenden Sessions, die Optionen sagen ohne Fachbegriffe, ob die Sessions weiterlaufen oder beendet werden, „Abbrechen“ lässt alles, wie es ist. Beide Optionen einmal wählen und danach prüfen, ob die Sessions noch laufen bzw. beendet sind.

### V1-14: Mehrere UI-Fenster verursachen weder doppelte Sessions noch doppelte Autostarts.

Status: automatisiert und manuell

Alle Fenster einer App teilen einen Main-Prozess und eine Verbindung zum Core; nur der Core löst den Autostart aus, und er belegt seine Pipe exklusiv.

- Test `packages/core/src/bin/run-core.test.ts`: `[V1-14] two cores started at once on one pipe and data directory: one runs, one autostart, one session`
- Test `packages/core/src/bin/run-core.test.ts`: `[V1-14] holds requests until the autostart sessions are registered; two clients see one start`
- Test `packages/core/src/bin/run-core.test.ts`: `[V1-14] fails with already_running before it creates or opens the data directory`
- Test `apps/desktop/src/main/core-connection.test.ts`: `[V1-14] starts the core once when nobody holds the pipe and connects as soon as it is up`
- Manuell: Mit einem Autostart-Profil und beendetem Core TermDock zweimal kurz nacheinander starten und ein zweites Fenster öffnen. Erwartet: Es läuft genau ein Core (ein Prozess mit `termdock-core` in der Befehlszeile, Task-Manager, Details), die Sidebar beider Fenster zeigt die Autostart-Session genau einmal, `wsl.exe -d Ubuntu --exec tmux -L termdock list-sessions` nennt sie genau einmal.

### V1-15: Windows-Shells funktionieren mit erkennbaren Persistenzgrenzen.

Status: automatisiert und manuell

Windows-Shells (`pwsh`, `powershell`, `cmd`) laufen als ConPTY im Core (#65, ADR 0003, Nachtrag in ADR 0005). Sie überleben das Schließen der Oberfläche, aber nicht das Ende des Core; Sidebar, Statusleiste, Formulare und Schließen-Dialog sagen das. Die Backend-Tests laufen mit echtem `cmd.exe` ohne WSL, auch in der CI.

- Test `packages/core/src/backend/windows/backend.test.ts`: `[V1-15] starts cmd.exe in the working directory, takes input from the writer and delivers the output`
- Test `packages/core/src/backend/windows/backend.test.ts`: `[V1-15] lets only the writer type and resize; the ConPTY takes the new size`
- Test `packages/core/src/backend/windows/backend.test.ts`: `[V1-15] ends Exited with the exit code of the shell, and exists is false afterwards`
- Test `packages/core/src/backend/windows/backend.test.ts`: `[V1-15] kill ends the shell, Exited with its exit code, no process left`
- Test `packages/core/src/backend/windows/backend.test.ts`: `[V1-15] restart starts a new shell after a separator line, never a second one`
- Test `packages/core/src/backend/windows/backend.test.ts`: `[V1-15] shows a late view the output so far from the raw buffer`
- Test `packages/core/src/backend/windows/backend.test.ts`: `[V1-15] archive and delete end the shell; a deleted session leaves no process`
- Test `packages/core/src/backend/windows/backend.test.ts`: `[V1-15] starts in the home directory with the warning cwd_missing when the directory is missing`
- Test `packages/core/src/backend/windows/backend.test.ts`: `[V1-15] refuses pwsh when it is not installed, with a message that names it; the session is Interrupted`
- Test `packages/core/src/bin/run-core-windows.test.ts`: `[V1-15] ends the shells on core.shutdown without stop; the next core finds the session Interrupted and restarts it`
- Test `packages/core/src/bin/run-core-windows.test.ts`: `[V1-15] starts a Windows autostart profile once after the core start, and stops it with core.shutdown { stopSessions }`
- Test `apps/desktop/src/main/smoke-test.test.ts`: `[V1-15] starts cmd.exe as an argument array, waits for its exit code and deletes the session`
- Test `apps/desktop/src/renderer/session-display.test.ts`: `[V1-15] marks Windows shells with a badge, a tooltip and the note of the status bar`
- Test `apps/desktop/src/renderer/session-display.test.ts`: `[V1-15] says nothing for WSL sessions, which live on in tmux`
- Test `apps/desktop/src/renderer/session-display.test.ts`: `[V1-15] says an interrupted Windows session ended with the core, which it only runs alongside`
- Test `apps/desktop/src/renderer/new-session.test.ts`: `[V1-15] builds a Windows launch spec with the chosen shell and directory`
- Test `apps/desktop/src/renderer/sidebar-model.test.ts`: `[V1-15] asks for name, backend and path; the backend note names the limit of Windows shells`
- Test `apps/desktop/src/renderer/sidebar-model.test.ts`: `[V1-15] starts a Windows shell in a Windows project; the shell comes from the settings (#65)`
- Test `apps/desktop/src/main/quit-flow.test.ts`: `[V1-13][V1-15] tells the dialog how many of the running sessions are Windows shells (#65)`
- Test `apps/desktop/src/shared/quit-decision.test.ts`: `[V1-13][V1-15] says that Windows shells run only as long as the core does`
- Szene `apps/desktop/src/main/screenshot-windows.ts` (Gruppe `windows`): `34-windows-new-session.png`
- Szene `apps/desktop/src/main/screenshot-windows.ts` (Gruppe `windows`): `35-windows-session.png`
- Szene `apps/desktop/src/main/screenshot-windows.ts` (Gruppe `windows`): `36-windows-project-dialog.png`
- Szene `apps/desktop/src/main/screenshot-windows.ts` (Gruppe `windows`): `37-windows-quit-dialog.png`
- Szene `apps/desktop/src/main/screenshot-windows.ts` (Gruppe `windows`): `38-windows-interrupted.png`
- Szene `apps/desktop/src/main/screenshot-windows.ts` (Gruppe `windows`): `39-windows-restarted.png`
- Manuell: In der installierten App eine Session „Neue Session“ mit Windows-Shell `pwsh` anlegen, `$PSVersionTable.PSVersion` eingeben, die Oberfläche mit „Sessions behalten“ schließen und neu öffnen. Erwartet: Die Shell läuft noch, Badge „Win“ und Statusleiste nennen die Grenze. Dann den Core im Task-Manager beenden (Details, `electron.exe` mit `termdock-core` in der Befehlszeile). Erwartet: Der Tab zeigt nach dem Neustart des Core „Unterbrochen“ mit dem Satz zum Core, „Neu starten“ startet eine neue Shell nach der Trennzeile, WSL-Sessions laufen weiter.

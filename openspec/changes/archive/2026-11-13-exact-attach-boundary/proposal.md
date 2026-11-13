# Proposal

## Why

Beim `session.attach` kann eine neue View Ausgabe doppelt oder gar nicht darstellen (Issue #34). Der Core hängt an den tmux-Snapshot die PTY-Ausgabe, die während der Abfrage eintraf (`inFlight`); `capture-pane` enthält diese Ausgabe aber oft schon, weil die PTY-Ausgabe (tmux-Client, dann ConPTY) dem Zustand des tmux-Servers hinterherläuft. Gemessen im WSL-Integrationstest: Eine View, die bei laufender Ausgabe anhängt, zeigt `… 143 144 145 142 143 144 145 146 …`. Dazu setzt der Desktop-Main seine Snapshot-Marke selbst, nicht der Core; zurückgehaltene Events in einem späteren Lesevorgang liegen dann über der Marke (ADR 0006).

## What Changes

- Der Core nummeriert die Ausgabe jeder Session fortlaufend. `session.output` trägt die Nummer (`seq`), die Attach-Antwort die Grenze (`outputSeq`): die Nummer der letzten Ausgabe, die nicht an die neue View ging. Zusätzliche optionale Felder, Protokoll **1.1** (MINOR, kein Breaking Change).
- Der Core hängt keine Ausgabe mehr an den Backend-Snapshot (`inFlight` entfällt). Stattdessen fordert er das Backend nach dem Registrieren der View auf, den Bildschirm vollständig neu zu zeichnen. Das WSL-Backend ruft dafür `tmux refresh-client` für die Clients der Session auf. Was zwischen Snapshot und Neuzeichnen doppelt oder fehlend ankommt, überschreibt das Neuzeichnen.
- Der Desktop-Main übernimmt `seq` und `outputSeq` des Core als Sequenznummer und Marke. Ohne die Felder (Core mit 1.0) zählt er wie bisher selbst.
- ADR 0003 (bekannte Grenze entfällt) und ADR 0006 (Marke vom Core) werden angepasst, ADR 0002 nennt Version 1.1.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `session-lifecycle`: „Snapshot für neue Views“ ohne angehängte Ausgabe; neu: Grenze zwischen Snapshot und Live-Ausgabe (Nummern, Marke, Neuzeichnen).
- `ipc-protocol`: neue optionale Felder `outputSeq` (Attach-Ergebnis) und `seq` (`session.output`), Version 1.1.
- `wsl-backend`: neu: Neuzeichnen über `refresh-client`.
- `desktop-shell`: Sequenznummer und Marke kommen vom Core.

## Impact

- Pakete: `packages/protocol` (`messages.ts`, `guards.ts`, `PROTOCOL_VERSION`), `packages/core` (`session/registry.ts`, `ipc/server.ts`, `backend/types.ts` mit optionalem `redraw`, `backend/fake.ts`, `backend/wsl/*`), `apps/desktop/src/main/bridge.ts`. Der Renderer bleibt unverändert.
- IPC: `session.attach` (Ergebnis), Event `session.output`. Datenmodelle: keine.
- Dependencies: `@xterm/headless` 6.0.0 als devDependency von `packages/core`, nur für den WSL-Integrationstest (Begründung im Design).
- Security: keine neuen Eingänge. Der Client-Name für `refresh-client` kommt von tmux und wird vor der Verwendung geprüft; alle Aufrufe bleiben Argument-Arrays.
- Non-Goals: Snapshot aus einem Terminal-Emulator im Core, Windows-Rohpuffer (seine Grenze ist schon exakt), Wiederverbinden des Desktop nach Core-Neustart.
- Phase: Fehlerbehebung zu Phase 1 (Core) und Phase 2 (Desktop, #24).

# Proposal

## Why

Der Datei-Explorer (#198) soll das aktuelle Verzeichnis der Session im aktiven Pane zeigen. Heute kennt TermDock nur das Startverzeichnis (`launch.cwd`); wohin die Shell danach mit `cd` wechselt, weiß weder der Core noch die App (#199). Für WSL-Sessions kennt tmux das Verzeichnis des Panes (`#{pane_current_path}`), ohne dass die Terminal-Ausgabe ausgewertet werden muss.

## What Changes

- Protokoll 1.8: optionales Laufzeitfeld `currentCwd` in `SessionInfo` und neues Event `session.cwdChanged { sessionId, currentCwd? }`. `currentCwd` folgt den Regeln für Pfade (1 bis 512 Zeichen) und enthält keine Steuerzeichen; der Core speichert es nicht.
- Backend-Schnittstelle: optionale Methode `currentCwd(id, spec)`. Das WSL-Backend fragt tmux mit `display-message -p '#{pane_current_path}'` als Argument-Array (`wsl.exe --cd ~ --exec`). Das Windows-Backend bekommt keine Umsetzung (#200 liest das Verzeichnis im Renderer).
- Registry: fragt das Verzeichnis gedrosselt ab, nur für Sessions mit laufender PTY und mindestens einer View: beim Anhängen einer View und nach einer Ausgabepause von 300 ms, höchstens eine Abfrage je Session gleichzeitig und höchstens eine je Sekunde. Sie meldet nur Änderungen. Verlässt eine Session `Running`/`Detached`, entfällt das Verzeichnis. Timer und Abfragen enden mit der PTY.
- Core-IPC: `session.cwdChanged` an Verbindungen mit einer View der Session und an Listenclients (wie `session.stateChanged`).
- Desktop: Der Main leitet das Event als Brücken-Event `cwdChanged` an alle Fenster; der Renderer führt `currentCwd` je Session im `UiStore` (`sessionCwdChanged`, reine Funktionen `withCurrentCwd` und `currentCwdOf` in `renderer/session-cwd.ts`). Es gibt keine sichtbare Änderung; das Panel folgt mit #202.

Phase: Erweiterung nach V1 (Datei-Explorer, Stufe 1, Eltern-Issue #198), aufbauend auf Phase 1 (Core, IPC, WSL-Backend).

## Capabilities

### New Capabilities

Keine.

### Modified Capabilities

- `ipc-protocol`: Versionsszenario in „Neustart im Vertrag“ auf 1.8 (MODIFIED), „Aktuelles Verzeichnis im Vertrag“ (ADDED).
- `wsl-backend`: „Aktuelles Verzeichnis aus tmux“, „Antwort der Verzeichnisabfrage“ (ADDED).
- `session-lifecycle`: „Aktuelles Verzeichnis laufender Sessions“, „Drosselung der Verzeichnisabfrage“, „Abbau der Verzeichnisabfrage“ (ADDED).
- `core-ipc`: „Empfänger von session.cwdChanged“ (ADDED).
- `desktop-shell`: „Aktuelles Verzeichnis an alle Fenster“, „Aktuelles Verzeichnis im Sessionmodell“ (ADDED).

## Impact

- Pakete: `packages/protocol` (`model.ts`, `messages.ts`, `guards.ts`), `packages/core` (`backend/types.ts`, `backend/wsl/commands.ts`, `backend/wsl/backend.ts`, `backend/fake.ts`, neues `session/cwd-probe.ts`, `session/registry.ts`, `storage/session-repository.ts`, `ipc/server.ts`), `apps/desktop` (`shared/bridge.ts`, `main/bridge.ts`, `renderer/session-sync.ts`, `renderer/ui-store.ts`, neues `renderer/session-cwd.ts`).
- IPC: neues Event `session.cwdChanged`, neues optionales Feld `SessionInfo.currentCwd`, Version 1.8. Keine neue Methode.
- Datenmodell: `SessionInfo.currentCwd` ist Laufzeitzustand und kommt nicht in die Datenbank.
- Abhängigkeiten: keine neue.
- Security: Quelle ist tmux, nicht die Terminal-Ausgabe; keine Escape-Sequenz wird ausgewertet. Aufruf als Argument-Array, Session-ID über `sessionName` geprüft. Pfade mit Steuerzeichen verwirft der Core, bevor sie einen Client erreichen.
- Prozesslast: höchstens ein `wsl.exe`-Aufruf je Session und Sekunde, nur für angezeigte Sessions mit Ausgabe; Sessions ohne View und dauernd laufende Ausgabe ohne Pause fragen nicht.
- Non-Goals: aktuelles Verzeichnis von Windows-Sessions im Core (#200), Datei-Dienst (#201), Panel (#202), tmux-Hooks oder Shell-Integration (OSC 7) für WSL.
- Breaking Changes: keine. Ein Client 1.7 verwirft das unbekannte Event (ADR 0002) und nimmt eine `SessionInfo` mit dem zusätzlichen Feld an, weil seine Guards in `SessionInfo` keine unbekannten Felder ablehnen.

# Proposal

## Why

Nach einem Windows-Neustart oder einem WSL-Stopp sind alle Sessions `Interrupted` (#156, beobachtet beim Test der Ausfall-Szenarien #133). Aus der App lässt sich keine davon neu starten: Das Protokoll hat kein `session.restart`, `SessionRegistry.restart` nutzt nur der Autostart. Das Pane zeigt den Platzhalter „Unterbrochen“, die Sidebar bietet nur Archivieren und Löschen. Wer weiterarbeiten will, legt jede Session neu an und wählt Name, Workspace, Startprofil und cwd erneut. Phase 4 (Kapitel 12 des Konzepts: Stabilität und Wiederaufnahme nach Ausfällen).

## What Changes

- Protokoll 1.6: neue Anfrage `session.restart { sessionId }` mit Ergebnis `{ session }`. Unbekannte Felder ergeben `bad_request`, eine unbekannte ID `not_found`, eine Session außerhalb von `Exited` und `Interrupted` (oder mitten in einem anderen Lifecycle-Aufruf) `invalid_state`.
- Core: `session.restart` ruft `SessionRegistry.restart`. Dieselbe ID, derselbe `LaunchSpec`, Workspace und Verlauf; Tab und Pane bleiben, weil das Layout die ID nennt. Besteht die tmux-Session noch, bindet der Core sich an, statt eine zweite zu starten. Zwei parallele Anfragen starten genau einmal, die zweite erhält `invalid_state`.
- Trennzeile: Jeder Neustart (auch der Autostart) schreibt als erste Ausgabe des neuen Laufs `--- Neu gestartet <Zeitpunkt> ---` in den Rohdaten-Puffer, an angehängte Views und in den Verlauf (bei aktivem Logging).
- Desktop: Bridge-Aufruf `restartSession { sessionId }`. Der Platzhalter eines Panes zeigt bei `Interrupted` und `Exited` den Knopf „Neu starten“; das Kontextmenü einer Session in der Sidebar bekommt den Eintrag „Neu starten“, nur in diesen Zuständen. Nach dem Neustart hängt sich das Pane wie gewohnt an.
- Screenshot-Gruppe `restore`: zwei neue Szenen `19a` (neu gestartete Session im Pane) und `19b` (Kontextmenü mit „Neu starten“), beide mit Sichtbarkeitsselektor.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `ipc-protocol`: neu „Neustart im Vertrag“ (ADDED).
- `core-ipc`: neu „Session über die IPC neu starten“ (ADDED).
- `session-lifecycle`: „Neustart“ (MODIFIED) um Trennzeile und parallele Aufrufe.
- `desktop-shell`: neu „Session aus der App neu starten“ und „Screenshot-Szenen für den Neustart einer Session“ (ADDED).

## Impact

- Pakete: `packages/protocol` (`messages.ts`, `guards.ts`, `model.ts`), `packages/core` (`ipc/server.ts`, `session/registry.ts`), `apps/desktop` (Bridge in `shared/bridge.ts`, `main/bridge.ts`, Preload, Renderer `pane-placeholder.ts`, `PaneTree.tsx`, `sidebar-model.ts`, `Sidebar.tsx`, `App.tsx`, Szene in `main/screenshot-restore.ts`).
- IPC: neue Methode `session.restart`; bestehende Methoden und Events unverändert. Datenmodell unverändert.
- ADR 0002 (Version 1.6) und ADR 0005 (Neustart über die IPC) werden ergänzt.
- Security: keine neuen Eingaben an Shells; der Neustart nutzt den gespeicherten `LaunchSpec` als Argument-Array wie jeder Start, Secrets im `env` sind schon beim Anlegen abgewiesen. Die Trennzeile ist reiner Text ohne Escape-Sequenzen.
- Non-Goals: Neustart mit geändertem `LaunchSpec` oder Profil; Neustart mehrerer Sessions auf einmal; ein Knopf in einer View, die nach dem Ende ihrer Session offen bleibt (dort genügt das Sidebar-Menü, die View empfängt den neuen Lauf).
- Breaking Changes: keine. Ein Core 1.5 beantwortet `session.restart` mit `bad_request`; Clients 1.2 bis 1.5 werden weiter angenommen.

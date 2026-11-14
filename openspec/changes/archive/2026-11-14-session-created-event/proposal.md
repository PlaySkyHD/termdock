# Proposal

## Why

Die Desktop-Brücke meldet eine neue Session an die Fenster nur, wenn der eigene `session.create`-Aufruf erfolgreich antwortet. Sessions, die ein anderer Client anlegt (ein zweiter Core-Client, später CLI oder Automationen), oder deren Antwort verloren geht, erscheinen erst nach dem nächsten `session.list` in der Sidebar (Issue #46, Review zu PR #35).

## What Changes

- Neues Core-Event `session.created { session: SessionInfo }`; MINOR-Erweiterung, `PROTOCOL_VERSION` wird `1.2`. Der Core sendet es nach dem Anlegen einer Session an alle Verbindungen, die `session.list` genutzt haben (wie `session.stateChanged`), auch an den Anleger, vor dessen Antwort und vor jedem `session.stateChanged` der Session.
- Sessions, die der Core beim Start aus dem Speicher lädt (Reconcile), werden nicht gemeldet; Clients holen sie mit `session.list`.
- Die Desktop-Brücke leitet `session.created` an alle Fenster weiter (Brücken-Event `sessionCreated`); ihre eigene Meldung nach `session.create` entfällt. Der Renderer übernimmt die Session idempotent.
- ADR 0002 nennt 1.2 und das Verhalten älterer Clients.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `ipc-protocol`: Anforderungen „Events“ und „Ausgabesequenz im Vertrag“ (Version 1.2).
- `core-ipc`: neue Anforderung „Event für neue Sessions“.
- `desktop-shell`: Anforderung „Events nur an beteiligte Fenster“; neue Anforderung „Neue Sessions in der Sidebar“.

## Impact

- `packages/protocol` (`messages.ts`, `guards.ts`, `model.ts`), `packages/core` (`session/registry.ts`, `ipc/server.ts`), `apps/desktop` (`main/bridge.ts`, `shared/bridge.ts`, Tests von `renderer/session-sync.ts`). ADR 0002 wird ergänzt.
- Dependencies: keine neuen. Non-Goals: Attach-Ergebnis und Snapshot, Terminal-Controller.
- Security: Das Event geht nur über die bestehende Pipe (nur aktueller Benutzer, ADR 0002); es enthält dieselben Felder wie die Antwort von `session.create`.
- Breaking Changes: keine. Ein Client mit `1.1` oder `1.0` verwirft das unbekannte Event (die Client-Bibliothek ignoriert Events, die der Parser ablehnt) und bleibt verbunden.

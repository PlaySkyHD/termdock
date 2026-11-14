# Proposal

## Why

Gruppenlose und gruppierte Sessions müssen sich umbenennen, verschieben, archivieren und löschen lassen (Konzept Kap. 6 und 8, Abnahme 10 und 12). Die Verträge `session.update`, `session.archive` und `session.delete` mit den Events `session.updated` und `session.removed` stehen seit #55 (Protokoll 1.3), der Core beantwortet sie aber noch mit `internal` „noch nicht umgesetzt“. Löschen muss auch den Verlauf auf der Platte entfernen (security.instructions.md) und darf keine tmux-Session zurücklassen.

## What Changes

- `SessionRegistry.update(sessionId, patch)`: Name, `workspaceId` (`null` = gruppenlos) und `loggingEnabled` ändern, in jedem Zustand, ohne den Prozess zu berühren; gespeichert wie jede Änderung.
- `SessionRegistry.delete(sessionId)`: nur aus `Exited`, `Interrupted`, `Archived` (sonst `invalid_state`). Beendet bei `Interrupted` eine verbliebene Backend-Session, entfernt `history/<sessionId>/`, dann die Zeile in `sessions`, trennt danach alle Views und vergisst die Session. Scheitert ein Schritt, bleibt die Session mit ihren Views.
- `SessionRepository.delete(sessionId)` (SQLite und In-Memory).
- `storage/history-files.ts`: Pfad `history/<sessionId>/` nach ADR 0004 mit Prüfung der Session-ID, rekursives und idempotentes Entfernen.
- IPC: `session.update` antwortet mit der Session und sendet `session.updated`; `session.archive` nutzt `SessionRegistry.archive` (Event `session.stateChanged` wie bisher); `session.delete` sendet `session.removed`. Nach Archivieren und Löschen vergisst der Server die Views der Session.
- `runCore` löst das Datenverzeichnis selbst auf und gibt der Registry das Entfernen des Verlaufs.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `session-lifecycle`: „Archivieren“ (Verlauf bleibt); neue Anforderungen „Session ändern“ und „Session löschen“.
- `session-persistence`: „Durchschreiben aus der Registry“ (Ändern und Löschen); neue Anforderung „Verlauf beim Löschen entfernen“.
- `core-ipc`: „Platzhalter für Methoden der Phase 3“ ohne die drei Session-Methoden; neue Anforderung „Sessions über die IPC verwalten“.

## Impact

- Paket `packages/core`: `session/registry.ts`, `storage/session-repository.ts`, `storage/history-files.ts` (neu), `ipc/server.ts`, `bin/run-core.ts`, Tests.
- Kein Vertragswechsel: `packages/protocol` und `apps/desktop` bleiben unverändert (UI folgt mit P3-8).
- Phase 3, Welle 1 (#57). Parallel: #56 (`clearWorkspace`), #59 (HistoryStore schreibt in dasselbe Verzeichnis).
- Non-Goals: UI, Prüfung, ob die Ziel-`workspaceId` existiert (Workspaces kommen mit #56), Schreiben des Verlaufs (#59).
- Security: Der Pfad des Verlaufs entsteht nur aus einer geprüften Session-ID (`[A-Za-z0-9_-]+`) und muss unter `<dataDir>/history/` liegen; `rm` folgt keinen Links. Löschen entfernt den Verlauf vor der Zeile, damit kein Verlauf ohne Session zurückbleibt.
- Breaking Changes: keine.

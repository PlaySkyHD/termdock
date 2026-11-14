# Design

## Kontext

Die Registry kennt Lifecycle, Views und Eingabe-Lock (ADR 0005); `archive` existiert seit Phase 1. Die IPC-Verträge für Ändern, Archivieren und Löschen stehen seit #55. Der Verlauf liegt nach ADR 0004 in `history/<sessionId>/` im Datenverzeichnis; der HistoryStore (#59) entsteht parallel.

## Entscheidungen

### Ändern ohne Prozess

`update` ändert nur Metadaten und ist in jedem Zustand erlaubt, auch `Archived` (Umbenennen im Archiv). `workspaceId: null` entfernt das Feld. Der Name wird wie im Guard geprüft (1 bis `MAX_NAME_LENGTH` Zeichen, nicht nur Leerzeichen), damit auch Aufrufer ohne Pipe keine ungültigen Namen speichern. Speichern über `persist` wie jede andere Änderung: Ein Speicherfehler geht an `onPersistError`, die Änderung gilt im Speicher (Anforderung „Fehler beim Speichern“). Ob die Ziel-`workspaceId` existiert, prüft #56; die Registry kennt keine Workspaces.

### Reihenfolge beim Löschen

1. Zustand `Exited`, `Interrupted` oder `Archived` und kein laufender Vorgang (`busy`), sonst `invalid_state`. `busy = "delete"` sperrt währenddessen `attach`, `update`, `restart`, `kill`, `archive` und ein zweites `delete`.
2. Nur bei `Interrupted`: `exists` im Backend, bei `true` `kill`. So bleibt keine tmux-Session übrig, auch wenn ein `Interrupted` nur den Client verloren hat. `Exited` und `Archived` überspringen das: Beim Exit-Code entfernt das Backend die tmux-Session selbst (ADR 0003), `archive` hat sie beendet; ein nicht erreichbares WSL soll ihr Löschen nicht verhindern. Scheitert `exists`, fragt der Core `available()`: Ist das Backend nicht verfügbar (kein WSL, kein tmux), kann dort nichts weiterlaufen und das Löschen geht weiter; sonst ergibt es `backend_unavailable` (vorübergehender Fehler, die tmux-Session könnte leben). Restlücke: Fehlt nur die Distro der Session, während die Standard-Distro läuft, meldet `available()` true und das Löschen bleibt `backend_unavailable` (wie heute beim Archivieren). Beenden-Fehler ergeben `backend_unavailable`. (Aus dem Review: zuerst prüfte das Löschen auch `Exited` und blockierte bei jedem Prüffehler.)
3. Verlauf entfernen (`removeHistory`), Fehler ergeben `internal`.
4. Zeile entfernen (`repository.delete`), Fehler ergeben `internal`.
5. Erst dann: Schreiber auf keinen setzen (`view.writerChanged` an die Views, die die Session noch nennt), Views leeren, Session vergessen.

Scheitert ein Schritt, bleibt die Session mit Views und Zeile bestehen; 2 und 3 sind idempotent, ein erneutes `delete` setzt fort. Verlauf vor Zeile: Bleibt nach einem Fehler etwas zurück, dann eine Zeile, die der Nutzer noch sieht und erneut löschen kann, nie ein Verlauf ohne Session. Wird die Registry währenddessen freigegeben (`dispose`), bricht `delete` vor dem nächsten Schritt mit `invalid_state` ab.

Verworfen: Views zuerst trennen. Dann hätte ein gescheitertes Löschen eine Session ohne Views hinterlassen, während der Server die Views noch kennt.

### Verlaufspfad

`storage/history-files.ts` bildet `<dataDir>/history/<sessionId>` nur aus einer Session-ID der Form `[A-Za-z0-9_-]+` (wie die tmux-Ziele, ADR 0003) und prüft, dass der aufgelöste Pfad unter `history/` liegt. `rm(..., { recursive, force, maxRetries: 3 })` ist idempotent und folgt keinen Links. Die Registry bekommt das Entfernen als Option `removeHistory` (Standard: nichts), damit sie das Dateisystem nicht kennt und Tests ohne Platte laufen. `runCore` löst das Datenverzeichnis jetzt selbst auf (`resolveDataDir`) und übergibt es an `openStorage` und `removeSessionHistory`. Der HistoryStore (#59) kann dieselbe Pfadfunktion nutzen.

### IPC

- `session.update`: Registry ändert, der Server sendet `session.updated` über `notifyListers` vor der Antwort (wie `session.created`) und antwortet `{ session }`.
- `session.archive`: `SessionRegistry.archive`; `session.stateChanged` mit `Archived` geht über den bestehenden Zustands-Listener an Views und Listen-Clients.
- `session.delete`: `SessionRegistry.delete`, danach `session.removed` an Listen-Clients.
- Nach Archivieren und Löschen entfernt der Server die View-Einträge der Session aus allen Verbindungen (`forgetSessionViews`). Sonst blieben sie bis zum Verbindungsende liegen; ein späteres `session.detach` dieser Views ergibt wie bisher `not_found`.

## Risiken

- #56 und #59 ändern dieselben Dateien (`registry.ts`, `session-repository.ts`, `run-core.ts`, `ipc.test.ts`). Eigene Methoden stehen direkt nach `archive()`, der Stub-Test filtert umgesetzte Methoden über eine eigene Menge, neue Tests liegen in eigenen Dateien.
- Schreibt der HistoryStore (#59) noch, während gelöscht wird? Gelöscht werden nur Sessions ohne Prozess, also ohne neue Ausgabe.

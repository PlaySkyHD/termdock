# Design

## Context

Die Session Registry (`packages/core/src/session/registry.ts`, Change `add-session-lifecycle`) hält `SessionInfo` nur im Speicher. ADR 0004 legt Ablage, Datenbank und Tabellen fest, ADR 0005 die Regeln für das Reconcile beim Core-Start. Parallel baut Issue #5 den IPC-Server und das Core-Binary (`src/ipc/`, `src/bin/`) gegen die öffentliche Registry-API; diese bleibt kompatibel. `model.ts`, `backend/types.ts` und `backend/fake.ts` bleiben unverändert.

## Goals / Non-Goals

**Goals:**

- Gespeicherte Sessions überstehen einen Core-Neustart; verlorene Prozesse erscheinen als `Interrupted` (Abnahme 9).
- Registry und Reconcile sind ohne Datei testbar (In-Memory-Repository), die SQLite-Ablage mit echten Dateien in Temp-Verzeichnissen.
- Keine neue Dependency.

**Non-Goals:**

- Repositories für Workspaces, Projekte und Layouts; Verlauf-Ringpuffer, Profile, Autostart.
- Melden von `backend_unavailable` an Clients (IPC, Issue #5 und später).

## Decisions

### `node:sqlite` mit `DatabaseSync`

ADR 0004 schreibt `node:sqlite` vor. `DatabaseSync` ist synchron; das passt zur Registry, deren Zustandswechsel synchron sind. Ein Schreibzugriff auf eine lokale WAL-Datenbank dauert Mikrosekunden, ein asynchrones Repository würde jeden Zustandswechsel unnötig asynchron machen. Node-Version: `node:sqlite` ist ab 22.5 vorhanden, aber erst ab 22.13 (und 23.4) ohne `--experimental-sqlite` nutzbar. `engines.node` steigt deshalb auf `>=22.13`. Die CI installiert mit `node-version: "22"` die aktuelle 22.x (geprüft mit 22.23.5) und bleibt unverändert; lokal läuft Node 25. In beiden Versionen gibt `node:sqlite` beim ersten Laden eine `ExperimentalWarning` aus; sie ist nur ein Hinweis und lässt die Tests nicht scheitern.

### Datenverzeichnis und Datei

`resolveDataDir(env)` liefert `TERMDOCK_DATA_DIR` oder `%APPDATA%\TermDock` und wirft, wenn beides fehlt. `openDatabase(file)` öffnet die Datei (oder `:memory:`), setzt `journal_mode = WAL`, `foreign_keys = ON` und `busy_timeout` und wendet die Migrationen an. `openStorage({ dataDir })` legt das Verzeichnis an und öffnet `termdock.db`. Die Funktionen bekommen Umgebung und Pfade als Argument, damit Tests nie `%APPDATA%` berühren.

### Migrationen

`MIGRATIONS` ist eine geordnete Liste `{ version, sql }`. `migrate(db)` legt `schema_version (version INTEGER PRIMARY KEY)` an (alle Tabellen als `STRICT`), liest die höchste Version und wendet jede neuere Migration in einer eigenen Transaktion zusammen mit dem Eintrag in `schema_version` an. Scheitert eine Migration, wird nur sie zurückgerollt und der Fehler weitergegeben. Ist die Datenbank neuer als der Code (höhere Version als bekannt), wird mit einem Fehler abgebrochen, statt ein fremdes Schema zu verändern.

### Schema (Migration 1)

- `sessions`: die Spalten aus ADR 0004 (`id`, `name`, `backend`, `distro`, `cwd`, `command`, `state`, `workspace_id`, `profile_id`, `created_at`, `updated_at`, `last_exit_code`, `logging_enabled`) plus `shell`, `env`, `cols`, `rows`. Ohne `shell`, `env` und Größe ließe sich `LaunchSpec` und `SessionInfo` nicht vollständig wiederherstellen; ADR 0004 wird entsprechend ergänzt. `command` und `env` sind JSON, `logging_enabled` ist 0/1. `CHECK`-Constraints sichern `backend` und `state` auf die bekannten Werte ab. `workspace_id` hat noch keinen Fremdschlüssel, weil die Registry Workspace-IDs ohne Workspace-Verwaltung annimmt; der Fremdschlüssel kommt mit dem Workspace-Issue.
- `workspaces` (`id`, `name`, `created_at`, `updated_at`), `projects` (`id`, `workspace_id` → `workspaces` mit `ON DELETE CASCADE`, `name`, `path`, `created_at`, `updated_at`), `layouts` (`id`, `workspace_id` → `workspaces` mit `ON DELETE CASCADE`, `data` als JSON, `updated_at`). Die Spalten sind die Minimalform aus Kapitel 3/4 des Konzepts; Änderungen kommen als neue Migrationen.

### `SessionRepository`

```ts
interface SessionRepository {
  list(): SessionInfo[]; // nach created_at, dann id
  save(session: SessionInfo): void; // Upsert
}
```

`SqliteSessionRepository` bildet `SessionInfo` auf Zeilen ab (`undefined` ↔ `NULL`, optionale Felder bleiben beim Lesen weg, wegen `exactOptionalPropertyTypes`). `writerViewId` wird nicht gespeichert. `InMemorySessionRepository` hält tiefe Kopien, damit spätere Änderungen an einem `SessionInfo` nicht unbemerkt im Repository landen. Kein `delete`: Löschen von Sessions gibt es noch nicht.

### Durchschreiben in der Registry

Neue optionale Option `repository` in `SessionRegistryOptions`. Die Registry ruft `repository.save` an genau den Stellen, an denen sich `SessionInfo` ändert: nach dem Anlegen (vor dem Start, damit auch ein Absturz während `Starting` die Session hinterlässt), in `setState` vor dem Melden, bei `resize` und bei Schreiberwechseln (nur `updatedAt`). Fehler des Repositories werden nicht verschluckt: sie gehen an den Aufrufer bzw. den PTY-Event-Handler. Alternative asynchrone Warteschlange verworfen: Reihenfolge und „gespeichert vor gemeldet“ wären nicht mehr garantiert.

### Reconcile über `SessionRegistry.restore()`

`restore()` ist eine Instanzmethode, damit der Aufrufer vorher Listener registrieren kann und Backends und Repository aus den Optionen nutzt. Sie verlangt ein Repository und eine leere Registry (sonst `invalid_state`), lädt alle Sessions und gleicht jede nach ADR 0005 ab:

- `Exited`, `Interrupted`, `Archived`: unverändert, kein Backend-Aufruf.
- Windows: `Interrupted`, kein Backend-Aufruf (die PTY gehörte dem alten Core).
- WSL (und jedes andere Backend mit Persistenz): Backend fehlt oder `available()` liefert `false`/wirft → `Interrupted`, Backend in `backendUnavailable`. `available()` wird pro Backend nur einmal gefragt. Sonst `exists()`: wirft → `Interrupted` und `backendUnavailable`; `false` → `Interrupted`; `true` → `attach()` mit der gespeicherten Größe, PTY anbinden, `Detached`. Scheitert `attach()`, wird die Session `Interrupted` (ohne `backendUnavailable`, weil das Backend erreichbar war).

Das Reconcile setzt den Zustand einer geladenen Session und ist kein Übergang einer laufenden Session: `Starting → Detached` ist in ADR 0005 für laufende Sessions nicht erlaubt, beim Reconcile aber genau die Regel für eine lebende WSL-Session. Deshalb umgeht `restore()` die Übergangstabelle bewusst und meldet keine `onStateChange`-Ereignisse (beim Start ist noch kein Client verbunden). Geänderte Sessions werden mit neuem `updatedAt` gespeichert. Das Ergebnis `RestoreResult` listet je Session `from`/`to` und die nicht erreichbaren Backends; der Core zeigt daraus `backend_unavailable` in der Statusleiste an. Die Sessions werden nacheinander abgeglichen, damit ein langsames WSL nicht mit vielen parallelen `wsl.exe`-Aufrufen belastet wird.

### Tests

- `storage/*.test.ts`: Migration auf leerer Datei, erneutes Öffnen, Roundtrip und Upsert für beide Repository-Implementierungen, Datenverzeichnis aus der Umgebung.
- `session/restore.test.ts`: Durchschreiben und alle Reconcile-Fälle mit `FakeBackend` und In-Memory-Repository, Neustart-Test (Abnahme 09) mit zwei Registries auf derselben SQLite-Datei im Temp-Verzeichnis.
- Datenbanken werden in `afterEach` geschlossen und Temp-Verzeichnisse danach gelöscht (Windows sperrt offene Dateien).

## Risks / Trade-offs

- `node:sqlite` ist noch experimentell; API-Änderungen in Node würden das Storage-Modul treffen. Es kapselt den Zugriff an einer Stelle.
- Synchrones Schreiben blockiert den Event-Loop kurz. Bei vielen Ausgabe-Events schreibt die Registry nicht (Ausgabe wird nicht gespeichert), nur bei Metadaten-Änderungen.
- `LaunchSpec.env` landet auf der Platte. Die Security-Regeln verbieten Secrets in `env`; die Datei liegt im Benutzerprofil.

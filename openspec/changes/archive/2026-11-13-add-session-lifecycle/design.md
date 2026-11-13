# Design

## Context

`packages/core` enthält bisher nur die Backend-Schnittstelle (`src/backend/types.ts`, ADR 0003). Domänentypen (`SessionInfo`, `SessionState`, `ErrorCode`) liegen in `packages/protocol/src/model.ts`. Beide Dateien bleiben unverändert. Parallel entsteht in `packages/protocol` der IPC-Vertrag (Issue #2); der Core darf deshalb nur die vorhandenen Domänentypen nutzen.

## Goals / Non-Goals

**Goals:**

- Eine Stelle für erlaubte Übergänge (`src/session/lifecycle.ts`), wie in ADR 0005 gefordert.
- Eine Registry, die der IPC-Server später ohne Umbau anbindet: Methoden entsprechen den späteren IPC-Methoden, Ereignisse den späteren Events.
- Tests ausschließlich über die öffentliche Schnittstelle mit `FakeBackend`.

**Non-Goals:**

- Persistenz, Reconcile beim Core-Start, Autostart, Verlauf (eigene Issues).
- Serialisierung über IPC und Zuordnung von Views zu Clients.

## Decisions

### Reine Übergangsfunktion

`transition(from, to)` liefert `to` oder wirft `CoreError("invalid_state")`; `canTransition(from, to)` ist die nicht werfende Variante. Die Tabelle ist ein `Record<SessionState, readonly SessionState[]>`, damit der Compiler fehlende Zustände meldet. Die Registry ruft für jeden Zustandswechsel `transition` auf, so dass kein Weg an der Tabelle vorbeiführt.

### Fehler mit stabilem Code

`CoreError extends Error` mit `code: ErrorCode` aus `model.ts`. Der IPC-Server übersetzt sie später 1:1 in Fehlerantworten (ADR 0002). Alternative eigener Fehlertyp in `protocol` verworfen: `protocol` gehört gerade Issue #2.

### Zustand aus Prozess und Views abgeleitet

`Running` und `Detached` unterscheiden sich nur in der Zahl der Views (ADR 0005). Die Registry führt pro Session die PTY und eine geordnete Menge von Views und setzt nach jedem Ereignis den passenden Zustand. Nach erfolgreichem Start geht es `Starting → Running` und, wenn keine View angehängt ist, sofort `Running → Detached`, weil ADR 0005 `Starting → Detached` nicht erlaubt. Views dürfen in jedem Zustand außer `Archived` angehängt sein, damit ein Tab nach `Exited` stehen bleibt und nach `restart` ohne erneutes Anhängen weiterläuft.

### Erste View wird Schreiber

Eine View wird nur dann automatisch Schreiber, wenn sie sich an eine Session ohne andere Views anhängt. Hängt sich nach dem Trennen des Schreibers eine weitere View an, während lesende Views bleiben, wird sie nicht Schreiber; sonst wäre sie ein automatischer Nachfolger, den ADR 0005 ausschließt. Die Übernahme erfolgt nur über `claimWriter`. Da der Core in einem Node-Thread läuft und `claimWriter` synchron ist, ist die Übernahme atomar.

### Ereignisse als typisierte Listener

`onOutput`, `onStateChange`, `onWriterChanged`, `onResized` registrieren Listener und geben ein `Disposable` zurück. Ausgabe-, Schreiber- und Größenereignisse enthalten die aktuellen `viewIds`, so dass der IPC-Server sie ohne Rückfrage an alle Views der Session verteilt. Alternative Node-`EventEmitter` verworfen: ohne Typsicherheit der Ereignisnamen und Nutzlasten.

### Ausgabepuffer

Ein Ringpuffer aus Chunks mit Obergrenze 256 KiB je Session, immer befüllt. Beim Anhängen wird zuerst `Backend.snapshot` gefragt (nur wenn ein Prozess lebt). Ausgabe, die während dieser Abfrage eintrifft, wird gesammelt und an den Backend-Snapshot angehängt; endet oder wechselt die PTY währenddessen, wird der Backend-Snapshot verworfen. Liefert das Backend `undefined`, wird der Puffer kopiert und die View im selben synchronen Schritt registriert, so dass zwischen Snapshot und Live-Ausgabe nichts verloren geht. Beim Neustart wird der Puffer geleert.

### PTY-Ende, kill, archive

- `onExit` mit Exit-Code → `Exited`, ohne → `Interrupted` (Interface-Kommentar in `types.ts`: unbekannter Exit-Code bedeutet verlorener Client).
- `kill` setzt eine laufende Operation; ein PTY-Ende währenddessen führt zu `Exited`. Nach `Backend.kill` wird die PTY freigegeben und `Exited` gesetzt, falls das PTY-Ende nicht schon kam.
- `archive` beendet einen lebenden Prozess über `Backend.kill`; bei `Interrupted` wird vorher `Backend.exists` gefragt, damit eine noch vorhandene tmux-Session nicht verwaist (Abnahme 10). Danach direkt `→ Archived`, ohne Zwischenzustand `Exited`.
- Während einer laufenden Operation (Start, kill, archive) werden weitere Lifecycle-Aufrufe mit `invalid_state` abgelehnt.

### Neustart

`restart` prüft `Backend.exists`; existiert die Backend-Session, wird `Backend.attach` statt `Backend.start` genutzt (keine doppelten Prozesse, Abnahme 14). Start- und Attach-Fehler führen zu `Interrupted` und `CoreError("backend_unavailable")`.

### FakeBackend

`src/backend/fake.ts` implementiert `Backend` vollständig im Speicher. Tests steuern Ausgabe (`emitData`), PTY-Ende mit oder ohne Exit-Code (`emitExit`), `exists`, Snapshots und Startfehler und lesen Eingaben, Resizes, Starts, Attaches und Kills aus. Exportiert über `src/index.ts`, damit spätere Pakete (IPC-Server, Desktop-Tests) es nutzen.

### Keine neuen Dependencies

UUIDs über `crypto.randomUUID` aus `node:crypto`. Vitest ist bereits im Root installiert.

## Risks / Trade-offs

- [Kurzes `Running` vor `Detached` nach dem Start] → Folgt aus ADR 0005; Listener sehen zwei Ereignisse. Der IPC-Server kann nach dem Start den Endzustand senden.
- [Backend-Snapshot und angehängte Ausgabe können sich überlappen] → Bei tmux unvermeidbar, weil der Zeitpunkt von `capture-pane` unbekannt ist; doppelte Bildschirmzeilen sind besser als Lücken. Der Puffer-Fallback ist lückenlos und ohne Überlappung.
- [Registry nur im Speicher] → Persistenz und Reconcile folgen in eigenen Issues; die Registry kapselt den Zustand, damit sie dort andocken.

# Design

## Context

`packages/protocol` liefert Codec, Guards und `negotiateHello`; `SessionRegistry` liefert Sessions, Views, Eingabe-Lock und typisierte Listener (`onOutput`, `onStateChange`, `onResized`, `onWriterChanged`). Der Server verbindet beides über `node:net` (ADR 0002) und setzt die Einzelinstanz aus ADR 0001 um.

## Goals / Non-Goals

**Goals:**

- Server und Client nur mit vorhandenen Typen und Guards; keine zweite Nachrichtendefinition.
- Verhalten über echte Pipe testbar (Pfad ist Option, eindeutiger Name je Test).
- Ein Client darf den Core nie zum Absturz oder zum unbegrenzten Speicherwachstum bringen.

**Non-Goals:** Daemonisierung, Autostart, Reconnect, echte Backends, Storage.

## Decisions

### Eine Verbindung = ein Zustandsobjekt

Je Verbindung: `FrameDecoder`, Handshake-Flag, eigene Views (`viewId → sessionId`), Flag „hat `session.list` genutzt“. Requests einer Verbindung werden nacheinander abgearbeitet (Promise-Kette), damit z. B. `attach` und das folgende `input` in Reihenfolge laufen. Verschiedene Verbindungen laufen unabhängig.

### Handshake

Die erste Nachricht muss ein gültiges `hello` sein. Sonst antwortet der Server mit `bad_request` (wenn die `id` lesbar ist) und baut die Verbindung ab. Bei Hauptversionsunterschied kommt `protocol_mismatch` (aus `negotiateHello`) und die Verbindung wird nach dem Schreiben geschlossen. Ein zweites `hello` ergibt `bad_request`.

### Views gehören zur Verbindung

Der Server vergibt die `viewId` (UUID) und führt `viewId → (Verbindung, sessionId)`. `input`, `resize`, `claimWriter`, `detach` mit einer fremden oder unbekannten `viewId` ergeben `not_found`; so kann ein Client die View eines anderen weder benutzen noch abhängen. Beim Schließen der Verbindung (auch bei Fehler) ruft der Server für jede View `detachView` auf und ignoriert Fehler (z. B. Session inzwischen archiviert). Endet die Verbindung, während `attach` noch läuft, wird die View direkt nach dem Anhängen wieder gelöst.

`session.attach` legt die View vor dem Registry-Aufruf an und hält Events dieser View zurück, bis die Attach-Antwort geschrieben ist. Damit sieht der Client nie ein Event vor der Antwort, die das Snapshot enthält. Die gewünschte `size` des Attach wird ignoriert: Der Schreiber bestimmt die Größe (ADR 0003); das Ergebnis trägt die Größe der Session. Ein Snapshot über 4 MiB wird auf die letzten 4 MiB gekürzt, damit der Frame gültig bleibt.

### Event-Routing

- `session.output`, `session.resized`, `view.writerChanged`: nur an Verbindungen mit einer View der Session (die Registry liefert `viewIds`); höchstens ein Event je Verbindung, auch bei mehreren Views.
- `session.stateChanged`: an Verbindungen mit einer View der Session **und** an alle Verbindungen, die `session.list` genutzt haben. Begründung: Ein Sessionliste-Client (Seitenleiste) muss Zustandswechsel auch ohne View sehen; er hat die Liste ja angefragt. Ein reiner `create`-Aufruf abonniert nichts.
- Ausgabe über 4 MiB wird in Frames bis zur Nutzdatengrenze geteilt.

### Fehlerabbildung

`CoreError` → `error { code, message }` unverändert. Alles andere → `internal` mit fester Meldung „Internal error“, ohne Stacktrace; die Ursache geht an die optionale Rückruffunktion `onInternalError` (der Einstieg schreibt sie ohne Stack auf stderr).

### Backpressure

Der Server schreibt mit `socket.write` und prüft danach `socket.writableLength`. Übersteigt der noch nicht abgenommene Puffer `maxBufferedBytes` (Standard 16 MiB), wird die Verbindung zerstört; ihre Views werden wie bei jedem Abbruch abgehängt. Der Core hält damit je Client höchstens diese Menge zusätzlich im Speicher; Sessions laufen weiter.

### Einzelinstanz

`listen` auf der Pipe scheitert mit `EADDRINUSE`, wenn ein anderer Prozess sie hält (Windows legt die erste Pipe-Instanz exklusiv an). Der Server wirft dann `AlreadyRunningError` mit `code: "already_running"`. `already_running` ist kein IPC-Fehlercode (kein Client sieht ihn über die Pipe), sondern ein Prozess-Exitgrund und steht deshalb nicht in `ERROR_CODES`. `runCore` fängt ihn, schreibt `termdock-core: already running on <pipe>` auf stderr und liefert Exit-Code 10; der Einstieg ruft damit `process.exit`. So ist das Verhalten ohne Prozessende testbar.

Der Pipe-Zugriff „nur aktueller Benutzer“ stützt sich auf den Standard-Sicherheitsdeskriptor von Node/libuv (Fremdbenutzer erhalten kein Lese-/Schreibrecht) und den Benutzernamen im Pipe-Namen. Eine explizite DACL ist nicht gesetzt; das ist eine bekannte Grenze.

### Shutdown

`core.shutdown { stopSessions }`: Bei `true` ruft der Server `kill` für jede Session in `Running` oder `Detached` auf (Fehler einzelner Sessions werden gesammelt und stoppen den Rest nicht), antwortet dann und schließt den Server: Listener schließen, alle Verbindungen nach dem Leeren der Schreibpuffer beenden, nach 1 s Rest zerstören. Bei `false` entfällt das Beenden. Phase 1 hat keine Daemonisierung; ohne `stopSessions` laufen Sessions deshalb nur so lange weiter, wie der Core-Prozess lebt (WSL-Sessions bleiben in tmux). Nach dem Schließen ruft der Server `onShutdown`; der Einstieg beendet den Prozess.

### Client-Bibliothek

`connect(pipePath, options)` öffnet die Pipe, sendet `hello` und liefert einen `CoreClient`. `request(method, params, payload?)` ist über `MethodMap` typisiert und liefert `{ result, payload }`; Fehlerantworten und Zeitüberschreitung (Standard 10 s) werden als `IpcError` mit `code` (`ErrorCode | "timeout" | "closed"`) abgewiesen. `on(event, listener)` liefert ein Disposable. `close()` zerstört den Socket, weist offene Requests mit `closed` ab und wartet auf das Schließen. Reconnect ist bewusst nicht enthalten (optional im Issue); `onClose` erlaubt dem Aufrufer, selbst neu zu verbinden.

### Einstieg

`termdock-core` erzeugt eine `SessionRegistry` ohne Backends (echte Backends kommen mit eigenen Issues; `session.create` ergibt bis dahin `backend_unavailable`), startet den Server auf dem Standardnamen und beendet sich bei SIGINT/SIGTERM sauber.

### Protokoll-Korrektur

`core.shutdown` trug in `MethodMap` den Parametertyp `Record<string, never>`, ADR 0001 und das Issue verlangen `stopSessions`. Der Typ erhält das optionale Feld, der Guard prüft es als Boolean. Abwärtskompatibel.

## Risks

- Sequenzielle Abarbeitung je Verbindung: Eine langsame `create`-Anfrage (Backend-Start) blockiert weitere Requests derselben Verbindung. Akzeptiert; Events laufen unabhängig weiter.
- `writableLength`-Grenze greift erst nach dem Schreiben; eine einzelne Nachricht kann die Grenze um höchstens ihre eigene Größe (4 MiB) überschreiten.

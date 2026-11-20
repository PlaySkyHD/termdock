# Design

## Kontext

Der Main hält genau eine Verbindung zum Core für alle Fenster (ADR 0006). Brücke, `LayoutCoordinator`, `QuitFlow` und der Screenshot-Modus bekommen beim Start ein `CorePort`-Objekt. Endet die Verbindung, sendet die Brücke `coreClosed`; jede View setzt ihre Rolle endgültig auf `closed`. WSL-Sessions überleben das Ende des Core in tmux, ein neuer Core bindet sie beim Abgleich wieder an (ADR 0001, ADR 0005).

## Entscheidungen

### Supervisor im Main

`core-supervisor.ts` kennt weder Electron noch Node-Prozesse. Eingespeist werden `connect()` (im Main `connectOrStartCore` mit `startDetachedCore`, also derselbe Weg wie beim App-Start), `now()`, `sleep(ms)`, `onState(state)` und `log`.

Zustände: `connecting` (vor dem ersten Erfolg), `connected`, `restarting`, `failed`, `stopped`.

- `start()` verbindet einmal. Scheitert das, wirft es wie bisher (Fehlerdialog, kein Neustart).
- Endet die Verbindung in `connected`, prüft der Supervisor die Neustarts der letzten 2 Minuten. Sind es weniger als 3, geht er nach `restarting`, merkt sich den Zeitpunkt und ruft `connect()`. Sonst geht er nach `failed`.
- Scheitert ein Neustart, zählt er ebenso. Unter der Grenze folgt nach 1 s der nächste Versuch, sonst `failed`.
- `restart()` (Knopf) wirkt nur in `failed`: Er leert die Liste der Zeitpunkte und beginnt wie oben.
- `stop()` (Beenden) setzt `stopped`; danach startet er nie mehr neu. Antwortet ein laufender Versuch danach, schließt er die neue Verbindung wieder. `close()` ist `stop()` plus Schließen der Verbindung.

Verworfen: Neustart im Renderer oder je Fenster. Der Main hält die eine Verbindung und startet den Core; zwei Fenster dürfen keinen zweiten Start auslösen (Abnahme 14).

### Stabile Port über Neustarts

Der Supervisor bietet `port: CorePort`. `request` geht an die aktuelle Verbindung, ohne Verbindung scheitert es sofort mit `IpcError("closed")`. `on` merkt sich jedes Abo und meldet es bei jeder neuen Verbindung neu an; `dispose` meldet es ab. `onClose` feuert bei jedem Ende einer Verbindung, nachdem der Supervisor seinen neuen Zustand gesetzt hat. So bleiben Brücke, Koordinator und Screenshot-Modus unverändert verdrahtet, und die Brücke kann im Close-Handler fragen, ob neu gestartet wird.

### Brücke

- `coreClosed { restarting }`: `restarting` aus dem Supervisor (`CoreRestarts.restarting()`). Vorher vergisst die Brücke alle Views, laufende Anhänge und Sequenznummern; die Views gehörten dem alten Core, ein späteres `detach` der Fenster endet mit `not_found`.
- `coreRestarted` an alle Fenster, sobald der Supervisor wieder `connected` ist; `coreClosed { restarting: false }`, wenn er `failed` wird.
- `restartCore` (ohne Argumente) ruft `restart()` des Supervisors und gibt `null` zurück.

### Renderer

- `TerminalController`: `coreClosed` setzt die Rolle auf `restarting` oder `closed`; in beiden Fällen sendet die View nichts mehr (Eingaben gehen verloren). Neue Option `claimOnOpen`: Nach dem Anhängen übernimmt die View das Schreibrecht, wenn die Funktion `true` liefert und sie Leser ist.
- `connectStore`: Nach `coreRestarted` holt es `session.list`, `workspace.list` und `core.status` und ruft dann `store.coreRestarted(sessions)`.
- `UiStore`: `coreRestarting`, `coreGeneration`. `coreRestarted` setzt Sessions, löscht `coreClosed` und erhöht die Generation in einem Schritt.
- `PaneTree` gibt `PaneView` die Generation als `key`: Jedes Pane wird neu eingehängt, `TerminalView` legt einen neuen Controller an und hängt an; nicht lebende Sessions zeigen wieder ihren Platzhalter. Das Pane-Element selbst behält seinen Schlüssel (Pane-ID, #67).
- `claimOnOpen` ist ab Generation 1 für das aktive Pane gesetzt und fragt `document.hasFocus()`: Nur das Fenster mit dem Fokus übernimmt, der Core gibt das Schreibrecht atomar weiter, also bleibt genau ein Schreiber je Session.
- Overlay im Pane: „Core startet neu …“ bzw. „Verbindung zum Core getrennt“ mit „Core neu starten“. Hinweis „Core neu gestartet“ im Fenster, schließt nach 4 s.

### Screenshot-Modus

Gruppe `restart` (`screenshot-restart.ts`): Session anlegen, Marke ausgeben, Neustart über `holdCoreRestart()` anhalten, den isolierten Core per Prozess-ID beenden (`killCore()`), „Core startet neu …“ aufnehmen, freigeben, auf „Core neu gestartet“ warten und aufnehmen. Geprüft werden: Marke im neuen Snapshot, Session `Running`, das Pane schreibt und nimmt Eingabe an. Der Lauf endet über `port`, also mit dem neuen Core. Der Halt ist nur eine eingespeiste Wartezeit vor `connect()` im Main des Screenshot-Modus.

## Risiken

- Ein Core, der beim Start abstürzt, erzeugt 3 Starts in kurzer Zeit (je bis 5 s Backoff), dann ist Schluss.
- Ein Layout-Speichern während des Neustarts scheitert und wird erst mit der nächsten Änderung nachgeholt.
- Ein Renderer, der während `failed` neu lädt, erfährt den Zustand erst mit dem nächsten Event; seine Aufrufe scheitern mit `closed`.

## Tests

- Unit: Supervisor (Neustart nach Ende, Grenze 3 in 2 Minuten mit eingespeister Uhr, Knopf setzt zurück, kein Neustart nach `stop`, fremder Core nur verbunden, Abos über Neustarts), Brücke (`coreClosed { restarting }`, `coreRestarted`, `restartCore`, Views vergessen), Controller (`restarting`, `claimOnOpen`), `connectStore` und Store (Generation, neue Liste), Renderer-Test mit Fake-Core: nach `coreRestarted` jede View neu angehängt, genau ein Schreiber.
- WSL-Integrationstest (`core-supervisor.wsl.test.ts`, `TERMDOCK_WSL_TESTS=1`): echter Core auf eigenem Pipe-Namen und Test-Socket, Prozess-Kill, Supervisor startet neu, Session `Detached` und Snapshot mit alter Ausgabe.

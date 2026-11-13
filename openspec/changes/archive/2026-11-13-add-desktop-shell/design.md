# Design

## Context

Der Core läuft als eigener Prozess hinter einer Named Pipe (ADR 0001, 0002); `packages/core` bringt die Client-Bibliothek `connect`/`CoreClient` (Optionen `connectTimeoutMs`, `requestTimeoutMs`) und `defaultPipeName` mit. Der PoC in `poc/` zeigt das Muster für Electron 45.3.1 mit xterm.js 6.0.0: Preload mit `contextBridge`, `sandbox`, CSP, Puffern der Live-Ausgabe bis zum Snapshot, Leser verwerfen `onData`, Screenshot per `capturePage()`. Die PTY gehört inzwischen dem Core, nicht mehr dem Main. Die erste Anfrage nach `hello` wartet im Core auf das Ende des Abgleichs (`assemble-core`), was bei vielen WSL-Sessions länger dauern kann als der Standard-Timeout von 10 s. Die WSL-PTY beantwortet DA1 selbst (ADR 0003). Der Snapshot im Protokoll enthält keine Cursorposition.

## Goals / Non-Goals

**Goals:**

- Ein kleiner, testbarer Kern, auf dem #26 bis #29 aufsetzen: Core-Verbindung im Main, typisierte Brücke, `TerminalView` mit einem DOM-freien Controller.
- Unit-Tests für Verbinden/Starten/Backoff/Timeout, für die Brücke und für den Controller, ohne Electron, ohne Pipe, ohne WSL.
- Ein reproduzierbarer Screenshot-Lauf, der den Produktiv-Core nie berührt.

**Non-Goals:**

- Sidebar, Tabs, Splits, Layout, Tastenkürzel; kein UI-Store (kommt mit #26 als reiner Store ohne React/Electron).
- Wiederverbinden nach einem Core-Absturz (die View zeigt nur „Verbindung zum Core getrennt“).
- Bündeln des Main, Installer, Auto-Update.

## Decisions

### Paketaufbau `apps/desktop`

```
src/shared/bridge.ts        Typen der Brücke (Aufrufe, Ergebnisse, Events, API im Fenster), Kanalnamen
src/main/core-connection.ts connectOrStartCore(), Timeout-Hülle für Anfragen
src/main/core-process.ts    Pfad des Core-Einstiegs, losgelöster Start
src/main/bridge.ts          DesktopBridge: Aufrufe prüfen, Views je Fenster, Events verteilen
src/main/screenshot.ts      Argument, isolierte Core-Umgebung, Warten auf Ruhe in der Ausgabe
src/main/main.ts            Electron-Verdrahtung (Einzelinstanz, Fenster, IPC, Screenshot-Ablauf)
src/preload/preload.cts     contextBridge, CommonJS, ohne lokale Laufzeit-Imports
src/renderer/…              index.html, main.tsx, App.tsx, TerminalView.tsx,
                            terminal-controller.ts, start-session.ts, styles.css
```

Main und Preload baut `tsc` (Projekt `tsconfig.node.json`, NodeNext, Ausgabe `dist/`), den Renderer baut Vite nach `dist/renderer`; `tsconfig.renderer.json` prüft ihn nur (DOM, `jsx: react-jsx`, `moduleResolution: Bundler`, Deklarationen nach `dist/.types`). `apps/desktop/tsconfig.json` verweist auf beide, das Root-`tsconfig.json` auf `apps/desktop`. Alternativen: electron-vite oder Vite auch für Main und Preload — verworfen, weil `tsc -b` den Main ohne weiteres Werkzeug baut und der Main nicht gebündelt werden muss (node_modules liegen neben der App).

Der Preload ist eine `.cts`-Datei: Ein Preload mit `sandbox: true` muss CommonJS sein und darf keine lokalen Module laden. Er importiert aus `shared/bridge.ts` nur Typen; die Kanalnamen stehen dort als Konstanten mit Literal-Typ, der Preload schreibt sie als Literal und `tsc` prüft sie gegen den Typ.

### Abhängigkeitsrichtung

Der Main nutzt die Client-Bibliothek aus `@termdock/core` (`connect`, `defaultPipeName`, `IpcError`) und startet den Core-Einstieg `packages/core/dist/bin/termdock-core.js`, den er über `createRequire(import.meta.url).resolve("@termdock/core")` findet (`import.meta.resolve` gibt es unter Vitest nicht). Das weicht von „desktop → protocol“ ab; die Regel in `.agents/instructions/typescript.instructions.md` wird auf „desktop-Main → core nur für Client-Bibliothek und Core-Einstieg“ präzisiert. Alternative: den Client nach `packages/protocol` verschieben — verworfen, `protocol` bleibt ohne Node-API, und Issue #25 arbeitet parallel in beiden Paketen. Renderer und Preload importieren nur Typen aus `@termdock/protocol`.

### Core verbinden oder starten (`connectOrStartCore`)

Reine Funktion mit injizierten Abhängigkeiten `connect`, `startCore`, `sleep`, `now`:

1. `connect(pipe)` einmal. Erfolg → fertig, `started: false`.
2. Sonst `startCore()` (wirft er, Abbruch mit `start_failed`), dann bis 5 s Gesamtzeit ab dem Start: warten (50, 100, 200, 400, 800, 1000, 1000 … ms, nie über die Restzeit hinaus), `connect`. Nach Ablauf Fehler `core_unreachable` mit dem letzten Verbindungsfehler.
3. Nach erfolgreichem Verbinden `core.status` als erste Anfrage; sie wartet auf den Abgleich.

Der Client wird mit `requestTimeoutMs = 60 000` verbunden, damit `core.status` beim Abgleich nicht abbricht. Alle späteren Anfragen laufen durch eine Hülle (`CorePort`) mit 10 s Timeout (`IpcError("timeout")`). Alternative: zwei Verbindungen oder ein Timeout je Anfrage in `CoreClient` — verworfen, Letzteres ändert `packages/core` (parallel #25), Ersteres verdoppelt Views und Events.

`startCore` startet `process.execPath` mit dem Core-Einstieg, `ELECTRON_RUN_AS_NODE=1`, `detached: true`, `stdio: "ignore"`, `windowsHide: true` und ruft `unref()`. Ein zweiter Core, der zwischen Schritt 1 und 2 von einem anderen Fenster gestartet wurde, endet selbst mit `already_running` (ADR 0001); das Verbinden findet dann den ersten.

### Brücke

Ein Kanal `termdock:call` (`ipcRenderer.invoke`) für alle Aufrufe, ein Kanal `termdock:event` (`webContents.send`) für Events. Aufrufe sind eine diskriminierte Union (`listSessions`, `createSession`, `attach`, `detach`, `input`, `resize`, `claimWriter`); die Antwort ist `{ ok: true, value } | { ok: false, error: { code, message } }`, weil Electron bei `invoke` nur die Fehlermeldung, nicht den Code überträgt. Der Preload macht daraus Promises, die mit einem `BridgeError`-ähnlichen Fehler (`code` in der Meldung als `[code] …`) abgelehnt werden.

`DesktopBridge` im Main kennt den Core nur über `CorePort` (`request`, `on`, `onClose`) und Fenster nur über `BridgeSender` (`id`, `send`). So ist sie ohne Electron testbar. Sie prüft jede Nachricht zur Laufzeit (unbekannte Methode, falsche Typen → `bad_request`), hält `viewId → { senderId, sessionId }` und je Sitzung die Fenster mit laufendem `attach`. Eingabe kommt als String und geht als UTF-8 an `session.input`; leere Eingabe wird nicht gesendet. `createSession` reicht die Parameter an den Core weiter, der sie mit seinen Guards prüft. Alternative: je Aufruf ein eigener Kanal — verworfen, mehr Verdrahtung ohne Gewinn an Sicherheit.

Events: `session.output`, `session.resized`, `view.writerChanged` an die beteiligten Fenster (je Fenster einmal), `session.stateChanged` an alle. Ausgabe während eines `attach` erreicht das Fenster, weil der Core Events nach der Antwort im selben Datenblock schicken kann, bevor der Main die View eingetragen hat.

### Terminal-View

`TerminalController` (ohne DOM, ohne React) steuert eine View über ein schmales `TerminalSurface` (`write`, `reset`, `resize`, `fit`, `onData`, `cols`, `rows`) und die Brücken-API: abonnieren, `attach`, Snapshot darstellen, gepufferte und Live-Ausgabe schreiben, Rolle aus `writerViewId` ableiten, `onData` nur als Schreiber senden, als Schreiber anpassen und `resize` senden, als Leser die Größe des Schreibers übernehmen, `claimWriter`, `dispose` mit `detach`. `TerminalView.tsx` erzeugt xterm.js und das Fit-Addon, verbindet sie als `TerminalSurface` und zeigt die Statusleiste. `start-session.ts` wählt die erste lebende Session oder legt eine WSL-Session in `~` an. Leser stellen das Terminal in der Schreibergröße dar; ist ihre Fläche kleiner, schneidet `overflow: hidden` ab (ADR 0006, Feinschliff in #27).

### Screenshot-Modus

`--screenshot <dir>` setzt vor allem anderen `userData` auf den festen Ordner `%TEMP%\termdock-screenshot-profile` und fordert keine Einzelinstanz-Sperre an (keine Übergabe an eine laufende App), wählt die Pipe `termdock-core-shot-<pid>-<zufall>` und gibt dem gestarteten Core `TERMDOCK_PIPE`, `TERMDOCK_DATA_DIR` (frisches Temp-Verzeichnis) und `TERMDOCK_TMUX_SOCKET=termdock-test` mit. Ablauf: Schreiberfenster öffnen, warten bis die Ausgabe nach dem ersten Byte 800 ms ruht, ein kleineres zweites Fenster öffnen (es findet die lebende Session und hängt sich als Leser an), `ls --color /` über die View des Schreibers senden, wieder auf Ruhe warten, kurz rendern lassen, alle Fenster aufnehmen, `core.shutdown { stopSessions: true }`, Datenverzeichnis entfernen (mit Wiederholungen, die Datenbank kann kurz gesperrt sein), `app.exit`. Gesamt-Timeout 90 s. `/` statt `~`, damit kein persönlicher Dateiname im Bild steht. Das Profil ist fest statt je Lauf, weil Electron seine Dateien bis zum Prozessende offen hält und der Lauf es nicht selbst löschen kann (erster Versuch: `EPERM`).

`termdock-core.ts` liest dafür `TERMDOCK_PIPE` und `TERMDOCK_TMUX_SOCKET` (leere Werte zählen als nicht gesetzt).

### Neue Dependencies

| Paket | Version | Grund |
| --- | --- | --- |
| `electron` (dev) | 45.3.1 | Wie im PoC geprüft; Node ≥ 22.13 für `node:sqlite` im Core (ADR 0004), node-pty-Prebuilds laden darunter. |
| `react`, `react-dom` | ^19.3.1 | Vom Issue vorgegeben; trägt Sidebar, Tabs und Splits aus #26 bis #27. |
| `@types/react`, `@types/react-dom` (dev) | ^19.3.0 | Typen für strict TypeScript. |
| `@xterm/xterm` | 6.0.0 | Terminal-Emulator, im PoC geprüft. |
| `@xterm/addon-fit` | 0.11.0 | Größe aus der Fläche, im PoC geprüft. |
| `vite` (dev) | ^7.3.8 | Baut den Renderer (TSX, CSS von xterm.js) ohne Inline-Skript; dieselbe Hauptversion liegt über Vitest schon im Baum. Kein `@vitejs/plugin-react`: esbuild übersetzt JSX, Fast Refresh wird nicht gebraucht. |

## Risks / Trade-offs

- [Snapshot ohne Cursorposition] → Nach dem Snapshot steht der Cursor am Ende der Daten. Die View bringt das Terminal vor dem Schreiben auf die Sitzungsgröße und entfernt Leerzeilen am Ende des Snapshots, sodass der Cursor bei einer Shell hinter dem Prompt steht (ohne das landete die Ausgabe im Leser in der letzten Zeile, außerhalb der beschnittenen Fläche). Bei Vollbildprogrammen stimmt der Cursor eines Lesers erst nach dem nächsten Neuzeichnen; Cursor im Protokoll ist ein eigener Change.
- [Electron lädt `@termdock/core` komplett, also auch node-pty und `node:sqlite`] → Beide laden unter Electron 45 (Phase 0, ADR 0004); Startzeit ist vernachlässigbar. Ein Unterpfad-Export nur für den Client wäre sauberer, ändert aber `packages/core/package.json` (parallel #25).
- [Core-stderr geht verloren, weil `stdio: "ignore"`] → Für einen losgelösten Prozess nötig; Logdatei kommt mit den Einstellungen.
- [Electron-Download in `npm ci` der CI] → Einmal je Lauf, vom npm-Cache nicht abgedeckt; akzeptiert.
- [Zwei Fenster starten gleichzeitig einen Core] → Kann im Einzelinstanz-Main nicht passieren; zwischen App und Skript endet der zweite Core mit `already_running`.

## Migration Plan

Neues Paket, keine Migration. Rückbau: Workspace-Eintrag und Referenz entfernen.

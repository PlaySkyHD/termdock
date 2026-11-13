# Design

## Context

`apps/desktop` zeigt nach #24 eine `TerminalView` je Fenster. `packages/protocol` kennt seit #25 `LayoutWindow`, `LayoutTab` und `LayoutPane`. Der Main ist der einzige Client des Core und leitet `session.stateChanged` schon an alle Fenster; der Core hat kein Event für neue Sessions, schickt Zustandswechsel aber nur an Clients, die `session.list` benutzt haben (der Main hat das mit dem ersten `listSessions` eines Fensters).

## Goals / Non-Goals

**Goals:**

- Sidebar, Tabs, Statusleiste und „Neues Fenster“ nach Issue #26.
- Ein reiner UI-Store, auf den Splits (#27), Keymap (#28) und Wiederherstellung (#29) direkt aufsetzen.
- Tabwechsel berührt den Prozess nie (Abnahme 04); Tab schließen löst nur die View.

**Non-Goals:** siehe Proposal.

## Decisions

### UI-Store (`src/renderer/ui-store.ts`)

Reine Klasse `UiStore` mit unveränderlichem Zustand, `getState()` und `subscribe()` (passt zu `useSyncExternalStore`). Zustand: `sessions` (nach `createdAt` sortiert, Core-Sicht), `window: LayoutWindow` (`id`, `sidebarVisible`, `tabs`, `activeTabId`), `coreStatus` und `coreClosed`. Ein Tab ist ein `LayoutTab` mit `root` als einzigem `LayoutPane` und `activePaneId` auf dieses Pane, also genau die Form, die #29 speichert. IDs kommen aus einer eingespeisten Funktion (`newId`), im Renderer `crypto.randomUUID()`, im Test ein Zähler. Aktionen: `setSessions`, `sessionCreated`, `sessionStateChanged`, `openSession(id, { forceNew })`, `focusTab`, `closeTab`, `toggleSidebar`, `setCoreStatus`, `markCoreClosed`.

- `openSession` fokussiert den Tab, dessen Pane die Session zeigt, sonst legt es einen Tab an und aktiviert ihn. `forceNew` (Strg+Klick) legt immer einen neuen Tab an. Bei 64 Tabs (`MAX_TABS_PER_WINDOW`) ändert es nichts und liefert `undefined`; die UI meldet das in der Statusleiste.
- `closeTab` aktiviert, falls der Tab aktiv war, den rechten Nachbarn, sonst den linken; ohne Tabs entfällt `activeTabId` (wie `LayoutWindow` es verlangt).
- Das Anzeigemodell (`session-display.ts`: Gruppen, Zustandsbezeichnung, Text der Statusleiste) ist ebenfalls rein. Gruppen: je `workspaceId` eine Gruppe mit der ID als Überschrift, alphabetisch, danach „Ohne Gruppe“ (immer vorhanden); `Archived` erscheint nicht.
- Zustandssymbole sind CSS-Formen mit Text als `title` und `aria-label`: Starting (Ring), Running (grüner Punkt), Detached (blauer Ring), Exited (graues Quadrat), Interrupted (orange Dreieck). Nur `Running` zeigt einen grünen Punkt; `Exited` und `Interrupted` tragen zusätzlich den Text „beendet“ bzw. „unterbrochen“ in der Statusleiste und gedämpfte Schrift in Sidebar und Tab (ADR 0005).

### Events in den Store (`session-sync.ts`)

`connectStore(store, api)` abonniert die Brücke zuerst, ruft dann `listSessions` und `coreStatus` auf und puffert Events bis zur Antwort (Zustandswechsel und neue Sessions), die danach auf die Liste angewendet werden; so geht kein Wechsel zwischen Anfrage und Antwort verloren. `stateChanged` einer unbekannten Session wird verworfen, `sessionCreated` fügt hinzu oder ersetzt (auch das Fenster, das sie angelegt hat, bekommt das Event). `coreClosed` setzt `coreClosed`.

### Brücke und Main

`coreStatus` ist ein weiterer Aufruf der festen Liste (Laufzeitprüfung `parseCall`, Test). Nach erfolgreichem `createSession` sendet die Brücke `sessionCreated` an alle Fenster. „Neues Fenster“ ist ein Menüpunkt (Strg+Umschalt+N) im Anwendungsmenü; das Menü ersetzt das Standardmenü und bietet außerdem Neu laden und Entwicklerwerkzeuge. Der Weg über `second-instance` bleibt unverändert; jedes Fenster ist ein eigener Renderer mit eigenem Store, also mit eigenen Tabs.

### Tabs bleiben angehängt

Alle Tabs eines Fensters bleiben gemountet und angehängt; inaktive werden nur mit `visibility: hidden` versteckt (übereinander gestapelt, gleiche Fläche). Alternative: inaktive Tabs lösen (`detach`) und beim Aktivieren neu anhängen, mit Snapshot. Verworfen, weil jeder Wechsel dann den Zustand der Session (Views, Schreibrecht, `Running` ↔ `Detached`) ändern würde, ein Snapshot ohne Cursor und Scrollback das Terminal verfälscht und die Ausgabe in der Zwischenzeit nicht fortläuft; ein Tabwechsel soll den Prozess nie berühren (Abnahme 04). Bleibt die Fläche gleich groß, löst das Verstecken keine `ResizeObserver`-Größenänderung aus, also schickt kein inaktiver Schreiber ein falsches `session.resize`. Kosten: ein xterm.js mit 5 000 Zeilen Scrollback je Tab (höchstens 64 je Fenster). Das Schließen eines Tabs entfernt die View und ruft `session.detach` auf (Controller `dispose`).

Ist die Session beim Öffnen `Exited` oder `Interrupted` (oder `Starting`), hängt der Tab nicht an, sondern zeigt Zustand und Exit-Code; sobald sie `Running` oder `Detached` ist, hängt er an. Ein einmal angehängter Tab bleibt es, auch wenn die Session endet: Die letzte Ausgabe bleibt sichtbar, die Statusleiste zeigt „Exited“.

### Statusleiste

Sie zeigt von links: Backend und Distro der aktiven Session (`WSL · Ubuntu`, ohne Distro „Standard-Distro“), Session und Zustand, Rolle und Größe der View, rechts Hinweise (`backendUnavailable` aus `core.status`: „WSL nicht erreichbar“, Core getrennt, Fehler der View, Tab-Limit) und „Schreibrecht übernehmen“ für Leser. Die Farbe folgt der Rolle der aktiven View wie bisher. `core.status` meldet den Abgleich beim Start des Core; ein späterer Ausfall von WSL zeigt sich als Zustand `Interrupted` der Sessions.

### Neue Session

Ein Formular in der Sidebar (Name, Arbeitsverzeichnis, Standard `~`; Distro ist die Standard-Distro) ruft `createSession` und öffnet danach den Tab. Anlegen dauert bei kaltem WSL bis zu 60 s; das Formular zeigt „Wird angelegt …“ und sperrt sich währenddessen.

### Screenshot-Modus

Der Lauf legt über die Brücke fünf Sessions an, öffnet sie über Klicks im Renderer (`webContents.executeJavaScript`, `data-`-Attribute der Sidebar): „Build“ (läuft, `ls --color /`), „Logs“ (läuft), „Notes“ (nur Sidebar, `Detached`), „Done“ (`exit` getippt, `Exited`) und „Lost“ (tmux-Session mit `wsl.exe -d Ubuntu --exec tmux -L termdock-test kill-session -t =td-<id>` beendet, `Interrupted`), nimmt das Fenster mit Sidebar auf, klappt die Sidebar ein und nimmt erneut auf. Ein zweites, kleineres Fenster zeigt zuerst den Leerzustand mit geöffnetem Formular, öffnet dann „Build“ als Leser. Der Gesamt-Timeout steigt auf 180 s, weil fünf Sessions nacheinander angelegt werden.

## Risks / Trade-offs

- [Viele gemountete Terminals] → höchstens 64 Tabs je Fenster, Scrollback 5 000; messbar erst bei vielen Tabs. Ein späteres Lösen alter Tabs wäre eine eigene Entscheidung.
- [Zustandswechsel vor `list`] → Der Core sendet `stateChanged` erst nach dem ersten `session.list` des Main; die Pufferung in `connectStore` deckt das Fenster zwischen Anfrage und Antwort ab.
- [Auto-Tab beim Start entfällt] → Bewusst: Ein Fenster ohne Tabs ist ein gültiger Zustand (`LayoutWindow.tabs` 0 bis 64). Wiederherstellung (#29) öffnet die zuletzt offenen Tabs.
- [Workspace-Überschrift ist die ID] → Bis Workspaces im Protokoll stehen (Phase 3) gibt es nur „Ohne Gruppe“.

## Migration Plan

Keine Daten betroffen. Rückbau: Commit zurücknehmen.

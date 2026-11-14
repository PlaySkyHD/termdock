# Design

## Kontext

Die Sidebar (`Sidebar.tsx`) gruppiert Sessions nach `workspaceId` und kennt weder Namen noch Projekte. Der Core liefert Workspaces mit Projekten über `workspace.list` und `workspace.changed` (vollständige Liste) und die Session-Verwaltung über `session.update|archive|delete` mit `session.updated` und `session.removed`; alle Events gehen an Verbindungen, die `session.list` genutzt haben (der Main tut das im ersten `listSessions`).

## Entscheidungen

### Brücke

Zehn neue Aufrufe, je einer je Core-Methode, ohne Zwischenlogik im Main außer der Laufzeitprüfung der Argumente (Typen, nicht leere IDs, Namen als Text; Länge und Syntax prüft der Core). `updateSession` nimmt `name?` und `workspaceId?: string | null`, mindestens eines. `createProject` nimmt Backend `wsl` oder `windows`, die Oberfläche bietet `wsl` an. Antworten: `listWorkspaces` die Liste, `updateSession` die Session, alle anderen `null` (der Renderer lernt das Ergebnis aus den Events, die der Core vor der Antwort sendet). Events: `workspaceChanged { workspaces }`, `sessionUpdated { session }`, `sessionRemoved { sessionId }` gehen wie `sessionCreated` an alle Fenster, auch für Änderungen eines anderen Clients. Bei `sessionRemoved` vergisst der Main die Sequenznummer der Session (kein Wachstum über die Lebensdauer).

### Store

`UiState` bekommt `workspaces` (Anlegereihenfolge des Core) und `workspacesLoaded`. `sessionUpdated(session)` übernimmt Name, `workspaceId`, `loggingEnabled` und `updatedAt` einer bekannten Session und lässt den Zustand unberührt (ein späteres oder früheres `stateChanged` gewinnt, nie ein älterer Zustand aus dem Update); eine unbekannte Session wird ergänzt. `sessionRemoved(id)` entfernt sie; ein Pane mit ihr zeigt danach den vorhandenen Platzhalter „Session nicht gefunden“ (`paneContent`), die Tabs bleiben bis zum Schließen. `connectStore` hört die drei Events, hält sie vor der ersten Liste zurück und wendet sie danach an (bei `workspaceChanged` gewinnt der Stand des Events vor der Liste), und holt `listWorkspaces` neben `listSessions`.

### Sidebar-Modell

Ein reines Modul (`sidebar-model.ts`) baut aus Sessions und Workspaces die Abschnitte: je Workspace Name, Projekte und Sessions (nicht archiviert), „Ohne Gruppe“ (auch für Sessions, deren Workspace dem Renderer unbekannt ist, damit nichts verschwindet) und das Archiv (alle `Archived`, unabhängig vom Workspace). Dazu die Zielregeln: eine Session darf auf einen anderen Workspace als den eigenen, auf „Ohne Gruppe“, wenn sie gruppiert ist, und auf das Archiv, wenn sie nicht archiviert ist; eine archivierte Session ist endgültig und lässt sich nicht ziehen. Dieselben Regeln speisen die Einträge des Kontextmenüs, damit Maus und Tastatur nicht auseinanderlaufen.

### Drag&Drop (`renderer/drag/`)

Natives HTML5-Ziehen läuft in einer Schleife des Betriebssystems und lässt sich nicht mit `sendInputEvent` fahren; es gäbe auch keine Abbruchtaste und keine Prüfung ohne DOM. Deshalb Zeigerereignisse in drei Schichten:

- `drag-model.ts` (rein): Zustandsmaschine `idle`, `pressed`, `dragging` mit Schwelle von 5 Pixeln, Eingaben `press`, `move`, `release`, `cancel` (Esc), Ergebnis: Hervorhebung (gültige Ziele, Ziel unter dem Zeiger) und beim Loslassen `drop` auf einem gültigen Ziel, sonst `cancel`. Nutzlast `DragPayload` mit `kind` (heute `session`; `tab` und `pane` für #67) und `id`; Ziele melden über `accepts(payload)`, ob sie sie annehmen.
- `drag-controller.ts`: hängt `pointermove`, `pointerup` und `keydown` ans Fenster, fragt eine Treffer-Funktion (Zeigerposition zu Ziel-ID) und meldet Zustandsänderungen; Esc und Verlust des Zeigers (`pointercancel`, `blur`) brechen ab. Nach einem Ziehen unterdrückt er den folgenden `click`, damit ein Ziehen keine Session öffnet. Abhängigkeiten (Fenster, Treffer-Funktion) sind eingespeist und im Test ersetzbar.
- `DragProvider.tsx`: React-Kontext mit `useDragSource` und `useDropTarget`. Ziele tragen `data-drop-target="<id>"`; Hervorhebung als CSS-Klassen (`drop-target--valid` für jedes gültige Ziel während des Ziehens, `drop-target--over` für das Ziel unter dem Zeiger), ein Schatten am Zeiger nennt die Session. Abbruch und Drop bleiben ohne Wirkung, wenn die Quelle verschwindet.

Ein Drop löst nur eine Aktion aus (`onDrop(payload, targetId)`); die Sidebar übersetzt sie in `updateSession` (Workspace oder gruppenlos) oder in die Bestätigung für das Archivieren. Der Store ändert sich erst über das Event des Core, nicht vorab.

### Bestätigungen und Eingabe

Löschen von Workspace, Projekt und Session sowie Archivieren zeigen einen modalen Dialog (Muster `QuitDialog`: Fokusfalle, Esc bricht ab, Klick neben den Dialog nichts, Standard ist „Abbrechen“). Der Text nennt die Folge: Löschen eines Workspace lässt Sessions laufen und macht sie gruppenlos; Archivieren beendet den Prozess (Verlauf bleibt); Löschen einer Session entfernt ihren Verlauf. Anlegen und Umbenennen nutzen einen kleinen Dialog mit Name (und Pfad bei Projekten), Esc bricht ab, Enter bestätigt. Ein Fehler des Core steht im Dialog beziehungsweise in der Statusleiste.

### Kontextmenü

Rechtsklick und die Menütaste (Ereignis `contextmenu`) öffnen ein Menü (`role="menu"`) an der Zeigerposition beziehungsweise am fokussierten Eintrag. Pfeiltasten wechseln den Eintrag, Enter wählt, Esc schließt und gibt den Fokus zurück. Session: Öffnen, Umbenennen, Verschieben nach jedem erlaubten Ziel, Archivieren, Löschen (nur `Exited`, `Interrupted`, `Archived`; sonst abgeblendet mit Hinweis). Workspace: Umbenennen, Projekt hinzufügen, Löschen. Projekt: Umbenennen, Löschen.

### Archiv

Das Archiv ist eingeklappt (Zeile mit Zähler und Pfeil); aufgeklappt zeigt es die archivierten Sessions mit einem Knopf „Löschen“. Klick auf den Eintrag öffnet den Tab mit Platzhalter „Archiviert“ (wie bisher).

## Verworfen

- Natives HTML5-Drag&Drop: nicht per `sendInputEvent` prüfbar, keine Abbruchtaste, Verhalten je Plattform.
- Optimistisches Verschieben im Store vor der Antwort: bei Ablehnung des Core wäre ein Zurückrollen nötig; das Event kommt vor der Antwort und genügt.

## Risiken

- Ein Zeigerereignis außerhalb des Fensters: `pointercancel` und `blur` brechen ab, ein Ziehen endet nie hängend.
- Viele Sessions: Die Sidebar scrollt; die Treffer-Funktion nutzt `elementFromPoint`, ein Aufruf je Mausbewegung.

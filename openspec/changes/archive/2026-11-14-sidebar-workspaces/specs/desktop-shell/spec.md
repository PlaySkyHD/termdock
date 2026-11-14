## MODIFIED Requirements

### Requirement: Schmale Brücke zwischen Renderer und Main

Der Renderer SHALL keinen Zugriff auf die Pipe, auf Node oder auf Electron-Module haben (`contextIsolation`, `sandbox`, kein `nodeIntegration`, CSP ohne Inline-Skripte). Der Main SHALL vom Renderer nur eine feste Liste von Aufrufen annehmen (Core-Status, Sessions auflisten, anlegen, ändern, archivieren, löschen, anhängen, lösen, Eingabe, Größe, Schreibrecht, Workspaces und Projekte verwalten, Layout, Schließen-Dialog), ihre Argumente prüfen und Fehler mit stabilem Code zurückgeben.

#### Scenario: Unbekannter Aufruf

- **WHEN** ein Renderer einen Aufruf außerhalb der Liste sendet, etwa `core.shutdown`
- **THEN** antwortet der Main mit `bad_request` und sendet nichts an den Core

#### Scenario: Fehler des Core

- **WHEN** der Core einen Aufruf mit einem Fehlercode ablehnt, etwa `not_found`
- **THEN** erhält der Renderer denselben Code und die Meldung

#### Scenario: Core-Status

- **WHEN** der Renderer `coreStatus` aufruft
- **THEN** sendet der Main `core.status` und gibt `backendUnavailable` zurück

#### Scenario: Ungültiges Layout gemeldet

- **WHEN** ein Renderer mit `reportLayout` einen Teil meldet, der die Prüfung des Layouts verletzt (etwa fünf Panes in einem Tab, eine doppelte ID oder ein unbekannter Schlüssel)
- **THEN** antwortet der Main mit `bad_request`, und das gespeicherte Layout bleibt unverändert

#### Scenario: Ungültige Antwort auf den Schließen-Dialog

- **WHEN** ein Renderer `answerQuit` mit einer unbekannten Wahl, ohne boolesches `remember` oder mit einer ID sendet, die nicht gefragt wurde
- **THEN** antwortet der Main mit `bad_request` bzw. `not_found`, und das Beenden ändert sich nicht

#### Scenario: Ungültiger Aufruf der Verwaltung

- **WHEN** ein Renderer `updateSession` ohne `name` und `workspaceId`, `createWorkspace` ohne Namen, `createProject` mit unbekanntem Backend oder `deleteSession` ohne ID sendet
- **THEN** antwortet der Main mit `bad_request` und sendet nichts an den Core

#### Scenario: Verwaltung geht an den Core

- **WHEN** ein Renderer `updateSession { sessionId: "s1", workspaceId: null }` und `archiveSession { sessionId: "s1" }` aufruft
- **THEN** sendet der Main `session.update` mit `workspaceId: null` und `session.archive` und gibt die geänderte Session beziehungsweise `null` zurück

### Requirement: Sidebar mit Sessions nach Workspace

Die Sidebar SHALL Workspaces mit Namen, Projekten und Sessions in der Reihenfolge des Core zeigen, darunter „Ohne Gruppe“ und ein Archiv. Archivierte Sessions stehen nur im Archiv, Sessions mit unbekanntem Workspace unter „Ohne Gruppe“. Jede Session SHALL ein Zustandssymbol tragen und sich über `session.stateChanged`, `sessionCreated`, `sessionUpdated`, `sessionRemoved` und `workspaceChanged` aktualisieren. Die Sidebar SHALL sich ein- und ausblenden lassen.

#### Scenario: Sessions ohne Workspace

- **GIVEN** der Core kennt zwei Sessions ohne `workspaceId`
- **WHEN** ein Fenster startet
- **THEN** zeigt die Sidebar beide im Bereich „Ohne Gruppe“

#### Scenario: Gruppe je Workspace

- **GIVEN** zwei Workspaces „Web“ und „Daten“, eine Session in „Web“ und ein Projekt in „Daten“
- **WHEN** die Sidebar sie anzeigt
- **THEN** stehen beide unter ihrem Namen in der Reihenfolge des Core, „Web“ mit der Session, „Daten“ mit dem Projekt, und „Ohne Gruppe“ zuletzt

#### Scenario: Zustandswechsel

- **GIVEN** die Sidebar zeigt `s1` als `Running`
- **WHEN** der Main `session.stateChanged` mit `Exited` meldet
- **THEN** zeigt die Sidebar `s1` als `Exited`

#### Scenario: Neue Session in anderem Fenster

- **GIVEN** zwei Fenster zeigen die Sidebar
- **WHEN** Fenster A eine Session anlegt
- **THEN** erscheint sie auch in der Sidebar von Fenster B

#### Scenario: Änderung eines anderen Clients

- **GIVEN** zwei Fenster zeigen die Sidebar, `s1` steht unter „Ohne Gruppe“
- **WHEN** ein anderer Core-Client `s1` in den Workspace „Web“ verschiebt und danach einen Workspace anlegt
- **THEN** steht `s1` in beiden Fenstern unter „Web“ und der neue Workspace erscheint in beiden

#### Scenario: Update ändert den Zustand nicht

- **GIVEN** die Sidebar zeigt `s1` als `Exited`
- **WHEN** ein `sessionUpdated` mit einem älteren Zustand `Running` und neuem Namen eintrifft
- **THEN** zeigt sie `s1` mit dem neuen Namen weiter als `Exited`

## ADDED Requirements

### Requirement: Workspaces und Projekte in der Sidebar verwalten

Die Sidebar SHALL das Anlegen, Umbenennen und Löschen von Workspaces und das Anlegen, Umbenennen und Löschen von Projekten anbieten. Namen und Pfade werden in einem kleinen Dialog erfasst (Esc bricht ab, Enter bestätigt); Löschen verlangt eine Bestätigung, deren Standard „Abbrechen“ ist. Ein Fehler des Core SHALL im Dialog stehen und ihn offen lassen.

#### Scenario: Workspace anlegen und umbenennen

- **WHEN** der Benutzer „Neuer Workspace“ wählt, „Web“ eingibt und bestätigt, danach ihn über das Menü in „Web 2“ umbenennt
- **THEN** zeigt die Sidebar den Workspace unter „Web 2“, und der Core hat `workspace.create` und `workspace.update` erhalten

#### Scenario: Projekt hinzufügen

- **WHEN** der Benutzer im Menü eines Workspace „Projekt hinzufügen“ wählt und Name und Pfad `/srv/api` bestätigt
- **THEN** erscheint das Projekt unter dem Workspace mit Backend WSL

#### Scenario: Workspace löschen

- **GIVEN** ein Workspace mit einer laufenden Session
- **WHEN** der Benutzer „Löschen“ wählt und bestätigt
- **THEN** ist der Workspace weg und die Session steht laufend unter „Ohne Gruppe“; bei „Abbrechen“ oder Esc bleibt alles unverändert

#### Scenario: Fehler des Core

- **GIVEN** der Core lehnt `workspace.create` ab
- **WHEN** der Benutzer bestätigt
- **THEN** zeigt der Dialog die Meldung und bleibt offen

### Requirement: Sessions per Drag&Drop ordnen

Der Benutzer SHALL eine nicht archivierte Session in der Sidebar auf einen Workspace, auf „Ohne Gruppe“ oder auf das Archiv ziehen können (`session.update` mit `workspaceId` beziehungsweise `null`, `session.archive`). Während des Ziehens SHALL jedes gültige Ziel hervorgehoben sein, das Ziel unter dem Zeiger zusätzlich. Eine archivierte Session ist nicht ziehbar; das Ziehen auf das Archiv verlangt die Bestätigung des Archivierens.

#### Scenario: Auf einen Workspace ziehen

- **GIVEN** eine Session unter „Ohne Gruppe“ und ein Workspace „Web“
- **WHEN** der Benutzer sie mit der Maus auf „Web“ zieht und dort loslässt
- **THEN** sendet der Main `session.update` mit der `workspaceId` von „Web“, der Prozess bleibt unberührt, und die Session steht unter „Web“

#### Scenario: Hervorhebung beim Ziehen

- **GIVEN** eine Session in „Web“ und ein zweiter Workspace
- **WHEN** der Benutzer sie zieht und über den zweiten Workspace fährt
- **THEN** sind der zweite Workspace, „Ohne Gruppe“ und das Archiv als gültige Ziele hervorgehoben, der zweite zusätzlich als aktuelles Ziel, und „Web“ ist nicht hervorgehoben

#### Scenario: Klick statt Ziehen

- **WHEN** der Benutzer die Maus um weniger als 5 Pixel bewegt und loslässt
- **THEN** öffnet der Klick die Session, und es beginnt kein Ziehen

#### Scenario: Auf das Archiv ziehen

- **GIVEN** eine laufende Session
- **WHEN** der Benutzer sie auf das Archiv zieht
- **THEN** fragt ein Dialog nach der Bestätigung; erst „Archivieren“ sendet `session.archive`, bei Abbruch bleibt die Session unverändert

### Requirement: Abbruch des Ziehens

Esc, ein Loslassen außerhalb gültiger Ziele und ein Verlust des Zeigers (`pointercancel`, `blur`) SHALL das Ziehen beenden, ohne einen Aufruf an den Core. Nach jedem Ziehen SHALL der folgende Klick unterdrückt sein, damit keine Session öffnet. Die Logik SHALL ohne DOM testbar sein und für Tabs und Panes (#67) wiederverwendbar bleiben.

#### Scenario: Esc bricht ab

- **GIVEN** eine Session wird gezogen
- **WHEN** der Benutzer Esc drückt und danach loslässt
- **THEN** verschwindet die Hervorhebung, es ergeht kein Aufruf an den Core, und die Session öffnet sich nicht

#### Scenario: Loslassen im Leeren

- **GIVEN** eine Session wird gezogen
- **WHEN** der Benutzer außerhalb jedes Ziels oder auf dem eigenen Workspace loslässt
- **THEN** ergeht kein Aufruf an den Core

### Requirement: Kontextmenü als Tastatur-Alternative

Rechtsklick, Menütaste und Umschalt+F10 auf einer Session, einem Workspace oder einem Projekt SHALL ein Menü (`role="menu"`) mit denselben Aktionen wie Maus und Drag&Drop öffnen: Sessions Öffnen, Umbenennen, Verschieben, Archivieren, Löschen; Workspaces Umbenennen, Projekt hinzufügen, Löschen; Projekte Umbenennen, Löschen. Pfeiltasten wechseln den Eintrag, Enter wählt, Esc schließt und gibt den Fokus zurück. Löschen einer Session ist nur in `Exited`, `Interrupted` und `Archived` wählbar.

#### Scenario: Verschieben per Tastatur

- **GIVEN** eine Session unter „Ohne Gruppe“ hat den Fokus
- **WHEN** der Benutzer die Menütaste, Pfeil abwärts bis „Verschieben nach Web“ und Enter drückt
- **THEN** sendet der Main `session.update` mit der `workspaceId` von „Web“

#### Scenario: Löschen einer laufenden Session

- **GIVEN** eine `Running`-Session
- **WHEN** der Benutzer ihr Menü öffnet
- **THEN** ist „Löschen“ abgeblendet und nicht wählbar

#### Scenario: Menü schließen

- **WHEN** der Benutzer bei offenem Menü Esc drückt
- **THEN** schließt es ohne Aufruf, und der Eintrag hat wieder den Fokus

### Requirement: Archiv-Bereich mit Löschen

Die Sidebar SHALL das Archiv eingeklappt zeigen, mit der Zahl archivierter Sessions. Aufgeklappt zeigt es jede archivierte Session mit der Aktion „Löschen“; sie verlangt eine Bestätigung, die den Verlust des Verlaufs nennt, und sendet danach `session.delete`. Archivieren verlangt ebenfalls eine Bestätigung, die das Beenden des Prozesses nennt.

#### Scenario: Archiv aufklappen

- **GIVEN** zwei archivierte Sessions
- **WHEN** der Benutzer das Archiv aufklappt
- **THEN** stehen beide mit „Löschen“ darunter, und eingeklappt zeigt die Zeile „2“

#### Scenario: Archivierte Session löschen

- **WHEN** der Benutzer bei einer archivierten Session „Löschen“ und im Dialog „Löschen“ wählt
- **THEN** sendet der Main `session.delete`, und die Session verschwindet aus dem Archiv

#### Scenario: Löschen abgelehnt

- **GIVEN** der Core lehnt `session.delete` mit `invalid_state` ab
- **WHEN** der Benutzer bestätigt
- **THEN** bleibt die Session im Archiv, und die Statusleiste zeigt die Meldung

### Requirement: Gelöschte Session im offenen Tab

Meldet der Main `sessionRemoved`, SHALL der Renderer die Session aus dem Store entfernen; ein Pane mit ihr zeigt danach den Platzhalter „Session nicht gefunden“ mit „Pane schließen“, und der Main vergisst ihre Sequenznummer. Das Event gilt für alle Fenster, auch bei einem Löschen durch einen anderen Client.

#### Scenario: Löschen durch anderen Client

- **GIVEN** Fenster A zeigt in einem Tab eine archivierte Session
- **WHEN** ein anderer Client sie löscht
- **THEN** zeigt der Tab in A den Platzhalter „Session nicht gefunden“, und die Sidebar listet sie nicht mehr

### Requirement: Screenshot-Szenen der Sidebar

Der Screenshot-Modus SHALL die Sidebar mit zwei Workspaces (mit Projekt) und gruppenlosen Sessions, das aufgeklappte Archiv, ein Ziehen mit echten Mausereignissen (`webContents.sendInputEvent`) mit Hervorhebung der Ziele und nach dem Loslassen die verschobene Session, das Kontextmenü, die Bestätigung des Löschens und den Platzhalter einer gelöschten Session aufnehmen. Tritt eine erwartete Änderung nicht ein, SHALL der Lauf mit Code 1 enden.

#### Scenario: Aufnahme

- **WHEN** die App mit `--screenshot <dir>` startet
- **THEN** enthält `<dir>` zusätzlich PNG-Dateien der Sidebar mit Workspaces, des Archivs, der Hervorhebung beim Ziehen, des Kontextmenüs und der Lösch-Bestätigung, und die gezogene Session steht danach im Ziel-Workspace

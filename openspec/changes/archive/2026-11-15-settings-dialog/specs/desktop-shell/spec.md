## MODIFIED Requirements

### Requirement: Schmale Brücke zwischen Renderer und Main

Der Renderer SHALL keinen Zugriff auf die Pipe, auf Node oder auf Electron-Module haben (`contextIsolation`, `sandbox`, kein `nodeIntegration`, CSP ohne Inline-Skripte). Der Main SHALL vom Renderer nur eine feste Liste von Aufrufen annehmen (Core-Status, Sessions verwalten, Views mit Eingabe, Größe und Schreibrecht, Workspaces und Projekte, Layout, Schließen-Dialog, Einstellungen, Startprofile, WSL-Distributionen), ihre Argumente prüfen und Fehler mit stabilem Code zurückgeben.

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

#### Scenario: Ungültiger Aufruf für Einstellungen und Profile

- **WHEN** ein Renderer `updateSettings` ohne Änderung oder mit einem unbekannten Schlüssel, `createProfile` ohne Namen oder ohne `launch`, `updateProfile` ohne Änderung oder `deleteProfile` ohne ID sendet
- **THEN** antwortet der Main mit `bad_request` und sendet nichts an den Core

#### Scenario: Einstellungen und Profile gehen an den Core

- **WHEN** ein Renderer `updateSettings { settings: { defaultDistro: null } }`, `updateProfile { profileId: "p1", change: { autostart: true } }` und `listDistros` aufruft
- **THEN** sendet der Main `settings.set`, `profile.update { profileId: "p1", autostart: true }` und `wsl.distros` und gibt die Einstellungen, das Profil und die Liste zurück

## ADDED Requirements

### Requirement: Änderungen an Einstellungen und Profilen an alle Fenster

Der Main SHALL `settings.changed` als `settingsChanged` und `profile.changed` als `profilesChanged` an alle Fenster weitergeben, auch für Änderungen anderer Clients. Ein offener Einstellungsdialog SHALL die neuen Werte übernehmen; ein Formular, das der Benutzer gerade bearbeitet, MUST seine Eingaben behalten.

#### Scenario: Zweites Fenster sieht die Änderung

- **GIVEN** zwei Fenster, im zweiten ist der Abschnitt Startprofile offen
- **WHEN** das erste Fenster ein Profil anlegt
- **THEN** zeigt die Liste des zweiten Fensters das neue Profil, ohne neu zu öffnen

### Requirement: Einstellungsdialog öffnen

Das Fenster SHALL den Einstellungsdialog mit `Ctrl+,` (Befehl der Keymap) und über „Datei → Einstellungen …“ öffnen; das Menü zeigt das Kürzel, ohne es selbst zu belegen, und öffnet den Dialog im fokussierten Fenster. Der Dialog SHALL modal sein wie die übrigen: Fokusfalle (auch über Auswahllisten und Textfelder), Escape schließt, danach hat das aktive Terminal den Fokus. Ein Fehler des Core SHALL im Dialog stehen und ihn offen lassen.

#### Scenario: Öffnen per Kürzel

- **GIVEN** ein Fenster mit einem Terminal im Fokus
- **WHEN** der Benutzer `Ctrl+,` und danach Escape drückt
- **THEN** erscheint der Dialog mit dem Abschnitt Allgemein und verschwindet wieder; keine der Tasten erreicht die Shell

#### Scenario: Öffnen über das Menü

- **WHEN** der Benutzer „Datei → Einstellungen …“ wählt
- **THEN** öffnet das fokussierte Fenster den Dialog

#### Scenario: Fehler des Core bleibt im Dialog

- **GIVEN** der Core lehnt das Speichern ab, etwa weil ein Profil einen Schlüssel `API_TOKEN` in der Umgebung hat
- **WHEN** der Benutzer speichert
- **THEN** zeigt der Dialog die Meldung des Core, bleibt offen und behält die Eingaben

### Requirement: Abschnitt Allgemein

Der Abschnitt Allgemein SHALL die Distribution (Auswahl aus `listDistros` plus „WSL-Standard“, ohne Liste ein freies Feld mit dem Grund), die Standardshell (pwsh, powershell, cmd oder keine), das Standardverzeichnis und den Schalter „Beim Schließen fragen“ (`confirmQuitWhileRunning`) zeigen. Speichern SHALL nur geänderte Schlüssel mit `updateSettings` senden; ein geleertes Feld MUST den Schlüssel entfernen (`null`).

#### Scenario: Nachfrage wieder einschalten

- **GIVEN** gespeichert ist `confirmQuitWhileRunning: false` mit `quitAction: "keepSessions"`
- **WHEN** der Benutzer „Beim Schließen fragen“ einschaltet und speichert
- **THEN** sendet das Fenster `settings.set { settings: { confirmQuitWhileRunning: true } }`, und das nächste Beenden mit laufenden Sessions fragt wieder

#### Scenario: Distribution aus der Liste

- **GIVEN** `listDistros` liefert `Ubuntu` (Standard) und `Debian`
- **WHEN** der Benutzer `Debian` wählt und speichert
- **THEN** ist `defaultDistro` `Debian`; wählt er danach „WSL-Standard“, sendet das Fenster `defaultDistro: null`

#### Scenario: WSL nicht verfügbar

- **GIVEN** `listDistros` liefert eine leere Liste mit Grund
- **WHEN** der Abschnitt öffnet
- **THEN** zeigt er den Grund und ein Textfeld für die Distribution

### Requirement: Abschnitt Verlauf

Der Abschnitt Verlauf SHALL das Limit je Session in MiB (64 KiB bis 1 GiB, also 0,0625 bis 1024) und den Schalter „Verlauf für neue Sessions“ (`historyEnabledByDefault`) zeigen und darauf hinweisen, dass der Verlauf unverschlüsselt auf der Platte liegt und mit der Session gelöscht wird. Ein Limit außerhalb der Grenzen oder keine Zahl MUST eine Meldung am Feld ergeben und nichts senden.

#### Scenario: Limit ändern

- **GIVEN** das Limit ist 10 MiB
- **WHEN** der Benutzer `20` einträgt und speichert
- **THEN** sendet das Fenster `historyLimitBytes: 20971520`

#### Scenario: Ungültiges Limit

- **WHEN** der Benutzer `0`, `2048` oder `zehn` einträgt
- **THEN** zeigt das Feld eine Meldung, und das Fenster sendet nichts

### Requirement: Abschnitt Kürzel

Der Abschnitt Kürzel SHALL die Übersicht der Keymap (dieselben Zeilen wie der Dialog „Tastenkürzel“) nur lesend zeigen.

#### Scenario: Übersicht im Dialog

- **WHEN** der Benutzer den Abschnitt Kürzel wählt
- **THEN** zeigt er jede Zeile der Übersicht mit Befehl und Kürzel, darunter `Ctrl+,` für die Einstellungen, und kein Eingabefeld

### Requirement: Startprofile im Dialog verwalten

Der Abschnitt Startprofile SHALL alle Profile mit Name, Backend und Befehl auflisten und Anlegen, Bearbeiten und Löschen (mit Rückfrage in der Zeile) anbieten. Der Editor SHALL Name, Backend, Distribution oder Shell, Verzeichnis, Befehl (ein Argument je Zeile), Umgebung (`NAME=Wert` je Zeile), Autostart und Verlauf zeigen und darauf hinweisen, dass Zugangsdaten nicht in die Umgebung gehören. Bearbeiten MUST Workspace und Projekt des Profils unverändert lassen.

#### Scenario: Profil anlegen

- **GIVEN** der Editor mit Name `Claude`, Backend WSL, Verzeichnis `/srv/app`, Befehl `claude` und `--continue` in zwei Zeilen, Autostart an
- **WHEN** der Benutzer speichert
- **THEN** sendet das Fenster `profile.create` mit `launch.command` `["claude", "--continue"]` und `autostart: true`, und die Liste zeigt das Profil

#### Scenario: Profil löschen

- **GIVEN** ein Profil in der Liste
- **WHEN** der Benutzer „Löschen“ und danach die Rückfrage bestätigt
- **THEN** sendet das Fenster `profile.delete`, und das Profil verschwindet aus der Liste; „Abbrechen“ sendet nichts

### Requirement: Formularprüfung der Startprofile

Das Fenster SHALL das Profil vor dem Senden prüfen: Der Name MUST nach Trimmen 1 bis 128 Zeichen haben; das Verzeichnis MUST leer oder `~` (Standardverzeichnis), für WSL sonst ein absoluter Linux-Pfad und für Windows ein Laufwerks- oder UNC-Pfad sein; der Befehl MUST ein Array sein (leer heißt Login-Shell), Zeilen werden nie an Leerzeichen geteilt; Umgebungsnamen MUST `[A-Za-z_][A-Za-z0-9_]*` sein und dürfen sich nicht wiederholen. Ein Fehler steht am Feld, und nichts wird gesendet.

#### Scenario: Leerer Name

- **WHEN** der Benutzer ein Profil mit dem Namen `   ` speichert
- **THEN** meldet das Feld Name einen Fehler, und das Fenster sendet nichts

#### Scenario: Ungültiger Pfad

- **WHEN** der Benutzer für WSL `srv/app` oder `C:\dev` als Verzeichnis einträgt
- **THEN** meldet das Feld Verzeichnis einen Fehler; für Windows ist `C:\dev` gültig und `/srv` nicht

#### Scenario: Befehl mit Leerzeichen

- **WHEN** der Benutzer `git log --oneline` in eine Zeile schreibt
- **THEN** ist der Befehl `["git log --oneline"]`, ein einziges Argument, nie eine Shell-Zeile

### Requirement: Screenshot-Szenen der Einstellungen

Der Screenshot-Modus SHALL den Dialog per `Ctrl+,` öffnen und die Abschnitte Allgemein, Verlauf, Kürzel, Startprofile mit Liste und Editor sowie eine Fehleranzeige des Core (Profil mit `API_TOKEN` in der Umgebung) aufnehmen. Er SHALL prüfen, dass ein gespeichertes Profil und eine geänderte Einstellung im Core ankommen; weicht etwas ab oder wartet eine Szene vergeblich, MUST der Lauf mit Code 1 enden.

#### Scenario: Aufnahme der Einstellungen

- **WHEN** die App mit `--screenshot <dir>` startet
- **THEN** enthält `<dir>` je ein PNG der vier Abschnitte, des Profil-Editors, der Profilliste und der Fehleranzeige

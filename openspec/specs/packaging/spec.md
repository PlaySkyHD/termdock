# packaging Specification

## Purpose
Legt fest, wie aus `apps/desktop` ein installierbares TermDock für Windows entsteht: Installer pro Benutzer, Inhalt des Pakets, Start des Core aus dem Paket, Prüfmodus der gebauten App und CI-Job (ADR 0007).

## Requirements

### Requirement: Installer pro Benutzer

`npm run dist -w apps/desktop` SHALL `apps/desktop/release/TermDock-Setup-<version>.exe` bauen: NSIS, x64, unsigniert, `appId` `io.github.playskyhd.termdock`, `productName` TermDock, ohne Publish-Ziel. Der Installer MUST nur für den aktuellen Benutzer nach `%LOCALAPPDATA%\Programs\TermDock` installieren, ohne Adminrechte und ohne Auswahl „für alle Benutzer“, und SHALL Startmenü- und Desktop-Verknüpfung anlegen.

#### Scenario: Installation ohne Adminrechte

- **GIVEN** ein Windows-Benutzer ohne Adminrechte
- **WHEN** er `TermDock-Setup-<version>.exe` ausführt
- **THEN** fragt der Installer weder nach Elevation noch nach „für alle Benutzer“
- **AND** TermDock liegt danach in `%LOCALAPPDATA%\Programs\TermDock` und startet über den Startmenü-Eintrag

#### Scenario: Konfiguration ohne Publish-Ziel

- **GIVEN** `apps/desktop/electron-builder.json`
- **WHEN** der Test die Konfiguration liest
- **THEN** sind `oneClick`, `perMachine` und `allowElevation` falsch, `publish` ist `null` und das Ziel ist `nsis`

### Requirement: Datenordner bleibt bei der Deinstallation

Die Deinstallation über „Apps“ SHALL das Programm entfernen und `%APPDATA%\TermDock` (Datenbank, Verlauf, Einstellungen) stehen lassen. Installer und Deinstaller MUST das auf ihrer Willkommensseite sagen, ebenso dass sie ein laufendes TermDock samt Core im Hintergrund beenden und laufende WSL-Sessions dabei weiterlaufen (der WSL-Keepalive überlebt den Core, #140).

#### Scenario: Deinstallation

- **GIVEN** ein installiertes TermDock mit Sessions in `%APPDATA%\TermDock`
- **WHEN** der Benutzer TermDock über „Apps“ deinstalliert
- **THEN** ist `%LOCALAPPDATA%\Programs\TermDock` entfernt
- **AND** `%APPDATA%\TermDock\termdock.db` ist noch da

### Requirement: Core im Paket

Im Paket SHALL der Main den Core mit `process.execPath` und `ELECTRON_RUN_AS_NODE=1` aus `resources/app.asar.unpacked/node_modules/@termdock/core/dist/bin/termdock-core.js` starten (ADR 0001). `@termdock/core`, `@termdock/protocol` und `node-pty` MUST außerhalb von `app.asar` liegen; node-pty wird nicht neu gebaut, sondern bringt N-API-Prebuilds mit. Außerhalb des Pakets gilt der bisherige Einstieg aus `packages/core/dist`.

#### Scenario: Einstieg im Paket

- **GIVEN** `coreEntryPath({ packaged: true, resourcesPath })`
- **WHEN** der Main den Core-Einstieg bestimmt
- **THEN** liegt er unter `<resourcesPath>/app.asar.unpacked/node_modules/@termdock/core/dist/bin/termdock-core.js`
- **AND** ein Muster in `asarUnpack` erfasst diesen Pfad und `node_modules/node-pty`

#### Scenario: Einstieg aus dem Repo

- **GIVEN** `coreEntryPath({ packaged: false, resourcesPath })`
- **WHEN** der Main den Core-Einstieg bestimmt
- **THEN** ist es die gebaute Datei `packages/core/dist/bin/termdock-core.js`

### Requirement: Electron-Profil und Taskleiste

Der Main SHALL `userData` ausdrücklich auf `%APPDATA%\@termdock\desktop` setzen, aus dem Repo und im Paket gleich, damit beide dieselbe Einzelinstanz-Sperre nutzen und nie zwei Mains auf einem Core laufen. Screenshot- und Prüfmodus ersetzen es weiter durch ihr eigenes Profil. Im Paket MUST der Main die AppUserModelID `io.github.playskyhd.termdock` setzen, gleich der `appId` des Installers.

#### Scenario: Installierte App neben laufender Repo-App

- **GIVEN** eine aus dem Repo gestartete App läuft
- **WHEN** der Benutzer die installierte App startet
- **THEN** übergibt sie an den laufenden Main und öffnet dort ein Fenster, statt einen zweiten Main zu starten

#### Scenario: Profilordner und ID

- **GIVEN** `appUserDataDir(%APPDATA%)` und `APP_USER_MODEL_ID`
- **WHEN** der Test sie prüft
- **THEN** ist der Ordner `%APPDATA%\@termdock\desktop` und die ID gleich der `appId` aus `electron-builder.json`

### Requirement: Prüfmodus der gebauten App

Mit `--smoke-test` SHALL die App ohne Fenster einen eigenen Core (eigene Pipe, tmux-Socket, Electron-Profil) starten, auf `hello` und `core.status` warten, ihn mit `core.shutdown { stopSessions: true }` beenden und mit Code 0 enden. Ohne `TERMDOCK_DATA_DIR`, mit `%APPDATA%\TermDock` oder einem Ordner darin, oder mit `--screenshot` MUST sie vor dem Start mit Code 2 enden. Andere Fehler, auch 90 s ohne Antwort, ergeben Code 1; einen später startenden Core wartet sie bis zu 15 s ab und beendet ihn.

#### Scenario: Erfolgreiche Prüfung ohne WSL

- **GIVEN** die entpackte App und `TERMDOCK_DATA_DIR` auf einem leeren Temp-Ordner, ohne WSL
- **WHEN** sie mit `--smoke-test` startet
- **THEN** startet sie den Core aus dem Paket, meldet das Backend `wsl` als nicht verfügbar und endet mit Code 0, nachdem der Core beendet ist

#### Scenario: Ohne Datenordner

- **GIVEN** kein `TERMDOCK_DATA_DIR`
- **WHEN** die App mit `--smoke-test` startet
- **THEN** endet sie mit Code 2, ohne einen Core zu starten oder `%APPDATA%\TermDock` zu öffnen

#### Scenario: Produktiver Datenordner

- **GIVEN** `TERMDOCK_DATA_DIR` ist `%APPDATA%\TermDock` oder ein Ordner darin, in beliebiger Schreibweise
- **WHEN** die App mit `--smoke-test` startet
- **THEN** endet sie mit Code 2, ohne einen Core zu starten

#### Scenario: Core startet nach dem Timeout

- **GIVEN** Verbinden und Starten antworten erst nach dem Timeout, aber innerhalb von 15 s danach
- **WHEN** die Prüfung den Timeout meldet
- **THEN** schließt sie die späte Verbindung, beendet erst danach den Core und endet mit Code 1

#### Scenario: Core antwortet nicht

- **GIVEN** ein Core, der nicht startet oder nicht antwortet
- **WHEN** die Prüfung läuft
- **THEN** beendet sie den gestarteten Core (Shutdown, sonst Kill) und endet mit Code 1

#### Scenario: Fremder Core auf der Pipe

- **GIVEN** auf der Pipe der Prüfung antwortet ein Core, den sie nicht gestartet hat
- **WHEN** die Prüfung läuft
- **THEN** endet sie mit Code 1 und lässt diesen Core in Ruhe

### Requirement: CI-Paketierung

Die CI SHALL in einem Job `package` auf `windows-latest` den Installer mit `npm run dist -w apps/desktop` bauen, die nativen Module von node-pty in der entpackten App laden, den Prüfmodus mit `TERMDOCK_DATA_DIR` im Temp-Ordner des Runners ausführen und den Installer als Artefakt mit 7 Tagen Aufbewahrung hochladen. Ein Fehlschlag eines Schritts MUST den Job rot machen.

#### Scenario: Pull Request

- **GIVEN** ein Pull Request gegen `main`
- **WHEN** die CI läuft
- **THEN** ist der Job `package` grün und das Artefakt `TermDock-Setup` enthält `TermDock-Setup-<version>.exe`

### Requirement: Icon

`apps/desktop/resources/icon.ico` SHALL die Größen 16 bis 256 px enthalten und aus `assets/icon.svg` stammen. `npm run icon -w apps/desktop` MUST es mit Electron reproduzierbar erzeugen; das Ergebnis ist eingecheckt.

#### Scenario: Größen im Icon

- **GIVEN** das eingecheckte `icon.ico`
- **WHEN** der Test seine Einträge liest
- **THEN** enthält es 16, 24, 32, 48, 64, 128 und 256 px

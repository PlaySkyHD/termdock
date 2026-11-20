# Design

## Kontext

Die App läuft bisher nur aus dem Repo. Der Core ist ein eigener Prozess, den Electron als Node startet (ADR 0001); der Main findet seinen Einstieg über `createRequire().resolve("@termdock/core")`. node-pty 1.1.0 bringt N-API-Prebuilds für `win32-x64` mit, ein Bau aus dem Quelltext scheitert auf dem Host (`docs/agent-lessons-learned.md`). SQLite ist `node:sqlite` und damit Teil von Electron. Nutzerentscheidung (#131): NSIS pro Benutzer, unsigniert, ohne Auto-Update.

## Entscheidungen

### electron-builder als neue devDependency

`electron-builder` 26.18.0 (gepinnt) in `apps/desktop`. Begründung: Es baut NSIS-Installer für Electron direkt, kennt `asarUnpack` für native Module, Installation pro Benutzer, Verknüpfungen und Deinstallation über „Apps“, und es ist der Weg, auf dem später electron-updater (#136) aufsetzt. Alternativen: Electron Forge mit Squirrel.Windows installiert ebenfalls pro Benutzer, hat aber keinen Assistenten, keinen frei wählbaren Ort und einen anderen Update-Weg; ein eigenes NSIS-Skript müsste Electron-Layout, asar und Verknüpfungen selbst pflegen. electron-builder lädt beim ersten Bau NSIS und 7-Zip aus seinen GitHub-Releases (gecacht), Electron nimmt es aus `node_modules/electron/dist` (`electronDist`), also dieselbe Version wie `npm start`. `npm audit` meldet über `minimatch` in seinen Abhängigkeiten eine moderate ReDoS-Lücke; sie betrifft nur den Build mit eigenen Mustern, nicht die App.

`@electron/rebuild` kommt nicht dazu: `npmRebuild: false` und `nodeGypRebuild: false`. node-pty lädt seine N-API-Prebuilds unter jeder Electron-ABI; ein Rebuild würde aus dem Quelltext bauen und scheitert auf dem Host. `node:sqlite` braucht keinen Treiber. Der CI-Schritt „Load native modules“ lädt `conpty.node` und `pty.node` mit dem gepackten Electron und beweist das bei jedem Lauf.

### Paketinhalt

- `files`: `package.json`, `dist/main`, `dist/preload`, `dist/shared`, `dist/renderer`, ohne Testdateien. React und xterm.js bündelt Vite in `dist/renderer`; ihre Pakete fehlen deshalb im Paket. Aus `@termdock/core` und `@termdock/protocol` fehlen `src`, Tests, Typen, Maps und Build-Infos.
- `asarUnpack`: `node_modules/@termdock/**` und `node_modules/node-pty/**`. So läuft der Core ganz außerhalb von `app.asar`; Node findet `@termdock/protocol` und `node-pty` neben ihm. Der Main lädt dieselben Dateien weiter über `app.asar` (Electron leitet entpackte Dateien um).
- `electronLanguages`: `de` und `en-US`, das spart etwa 48 MB.

### Core-Einstieg

`coreEntryPath({ packaged, resourcesPath })` ist rein: mit `packaged` der Pfad unter `resources/app.asar.unpacked`, sonst der bisherige. `main.ts` übergibt `app.isPackaged` und `process.resourcesPath`. Ein Test prüft, dass `asarUnpack` diesen Pfad erfasst, damit Konfiguration und Code nicht auseinanderlaufen.

### Prüfmodus `--smoke-test`

Nach dem Vorbild des Screenshot-Modus (ADR 0006): eigene Pipe und eigener tmux-Socket (`isolatedCore`), Electron-Profil unter `<TERMDOCK_DATA_DIR>/electron-profile`, keine Einzelinstanz-Sperre, kein Fenster. `TERMDOCK_DATA_DIR` ist Pflicht, sonst öffnete der Core die produktive Datenbank. Ablauf in `smoke-test.ts` (ohne Electron, getestet): `connectOrStartCore` (Start, `hello`, `core.status`), `started` muss wahr sein, dann `stopIsolatedCore` und Prüfung, dass der Prozess weg ist. Exit-Codes: 0 Erfolg, 1 Fehler oder 90 s ohne Antwort, 2 falsche Argumente. `main.ts` ändert sich nur am Core-Einstieg und um diesen Zweig.

### Installer

- `oneClick: false`, `perMachine: false`, `allowElevation: false`, `packElevateHelper: false`. Bei `perMachine: false` zeigt electron-builder sonst die Auswahl „für alle Benutzer / nur für mich“; das Makro `customInstallMode` in `resources/installer.nsh` setzt `isForceCurrentInstall` und überspringt sie. Ziel ist damit immer `%LOCALAPPDATA%\Programs\TermDock`, der Ort ist nicht wählbar.
- Verknüpfungen: Startmenü und Desktop. electron-builder hat für die Desktop-Verknüpfung keine Checkbox; der Benutzer kann sie löschen, ein Update legt sie dann nicht neu an. Die „optionale“ Desktop-Verknüpfung aus #131 ist damit eine Einstellung im Build, keine Wahl im Assistenten.
- `deleteAppDataOnUninstall: false`; die Willkommensseiten (`customWelcomePage`, `customUnWelcomePage`) nennen Zielordner, Datenordner und die fehlende Signatur.
- Laufende TermDock-Prozesse (auch der Core, er ist `TermDock.exe` als Node) schließt der Installer vor dem Überschreiben nach Rückfrage. WSL-Sessions laufen in tmux weiter, solange WSL läuft, und werden beim nächsten Start wieder angebunden (ADR 0005); Windows-Sessions gibt es noch nicht.

### Icon

`scripts/make-icon.mjs` läuft in Electron: Chromium zeichnet `assets/icon.svg` in ein Canvas in 16, 20, 24, 32, 40, 48, 64, 128 und 256 px; bis 128 px als 32-Bit-DIB, 256 px als PNG. Kein weiteres Paket. Weil der Buchstabe die Systemschrift nutzt, ist das Ergebnis eingecheckt; das Skript ist die dokumentierte Quelle.

### CI

Job `package` parallel zu `check`, gleiche Aktionen (`checkout`, `setup-node`, per SHA gepinnt), dazu `actions/upload-artifact` v7.0.2 per SHA. Schritte wie lokal: `npm ci`, `npm run dist -w apps/desktop`, Laden der nativen Module, `TermDock.exe --smoke-test` mit `TERMDOCK_DATA_DIR` unter `runner.temp`, Upload mit 7 Tagen. Git Bash wartet auf das GUI-Programm und reicht seinen Exit-Code weiter.

## Risiken

- Der Bau lädt NSIS und 7-Zip aus dem Netz; fällt GitHub aus, scheitert der Job.
- Ohne Signatur warnt SmartScreen; das ist entschieden.
- Electron legt sein Profil (Cache, Local Storage) unter `%APPDATA%\TermDock` neben `termdock.db`; der Renderer speichert dort keinen eigenen Zustand (Layout und Einstellungen liegen im Core).

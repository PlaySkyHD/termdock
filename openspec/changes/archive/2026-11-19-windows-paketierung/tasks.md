# Tasks

## 1. Core-Einstieg

- [x] 1.1 Test und Umsetzung: `coreEntryPath({ packaged, resourcesPath })` für Paket und Repo (`main/core-process.test.ts`, `core-process.ts`); `main.ts` übergibt `app.isPackaged` und `process.resourcesPath`

## 2. Prüfmodus

- [x] 2.1 Test und Umsetzung: `smokeTestRequested`, `smokeTestDataDir` (Pflicht `TERMDOCK_DATA_DIR`) und `runSmokeTest` (Erfolg, Startfehler, fremder Core, Kill, Timeout) in `main/smoke-test.test.ts`, `smoke-test.ts`
- [x] 2.2 `main.ts`: Zweig `--smoke-test` mit `isolatedCore`, eigenem Electron-Profil, Exit-Code 2 ohne Datenordner oder zusammen mit `--screenshot` (geprüft mit der entpackten App: Code 0 mit, Code 2 ohne `TERMDOCK_DATA_DIR`)

## 3. Paketierung

- [x] 3.1 `electron-builder` 26.18.0 als devDependency, `electron-builder.json`, Skript `dist`, `release/` in `.gitignore`; Test der Konfiguration und von `asarUnpack` gegen `coreEntryPath` (`main/packaging.test.ts`)
- [x] 3.2 `resources/installer.nsh`: nur aktueller Benutzer, Willkommensseiten mit Datenordner (Test in `main/packaging.test.ts`)
- [x] 3.3 `scripts/make-icon.mjs` und Skript `icon`, `resources/icon.ico` eingecheckt (Test der Größen in `main/packaging.test.ts`)
- [x] 3.4 Lokaler Bau `npm run dist -w apps/desktop` und Prüfmodus der entpackten App mit `TERMDOCK_DATA_DIR` unter `P:/Temp/` (Exit-Code 0)

## 4. CI und Dokumentation

- [x] 4.1 Job `package` in `.github/workflows/ci.yml` (Bau, native Module, Prüfmodus, Artefakt 7 Tage); YAML lokal geparst, Befehle lokal ausgeführt
- [x] 4.2 ADR 0007 „Paketierung und Installer“ mit dem manuellen Abnahmeschritt, ADR 0006 verweist darauf

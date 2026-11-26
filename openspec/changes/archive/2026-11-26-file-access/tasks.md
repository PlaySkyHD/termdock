# Tasks

## 1. Orte und Namen

- [x] 1.1 Test und Umsetzung: Prüfung und Übersetzung der Orte (`checkWslPath`, `checkWindowsPath`, `checkLocation`, `toFsPath`), Namensprüfung, Programm-Endungen (`main/file-paths.test.ts`, `file-paths.ts`)

## 2. Dienst

- [x] 2.1 Test und Umsetzung: `list` mit Typen, Größe, Zeit, Symlinks und Obergrenze (`main/file-service.test.ts`, `file-service.ts`)
- [x] 2.2 Test und Umsetzung: `rename` und `move` ohne Überschreiben (`EEXIST`), Namen, Wurzel, Backend-Wechsel (`main/file-service.test.ts`)
- [x] 2.3 Test und Umsetzung: `delete` rekursiv, Wurzel, Symlink (`main/file-service.test.ts`)
- [x] 2.4 Test und Umsetzung: `download` für Datei und Ordner, Abbruch, vorhandenes Ziel, geprüfter Dialogpfad (`main/file-service.test.ts`)
- [x] 2.5 Test und Umsetzung: `reveal` und `open`, Programm-Endungen, keine Shell-Meldung (`main/file-service.test.ts`)
- [x] 2.6 Test: ungültige Orte ergeben `EINVAL` bei jeder Operation, Distro-Liste im Zwischenspeicher, Fehlercodes, Log ohne Pfade (`main/file-service.test.ts`)
- [x] 2.7 Test: lokaler Lauf gegen `\\wsl.localhost\Ubuntu\tmp` mit `TERMDOCK_WSL_TESTS=1` (`main/file-service.test.ts`)

## 3. Brücke

- [x] 3.1 Test und Umsetzung: `parseFileRequest` und `FileBridge` (`main/file-bridge.test.ts`, `file-bridge.ts`, `shared/files.ts`)
- [x] 3.2 Umsetzung: Kanal im Main, Dialoge und Shell als Abhängigkeiten (`main/main.ts`), `window.termdock.files` (`preload/preload.cts`, `shared/bridge.ts`), geprüft durch den Typecheck
- [x] 3.3 Test: keine Shell-Strings und keine Prozesse im Dateizugriff, der Kanal wird nur im Main registriert (`main/security.test.ts`)

## 4. Dokumentation

- [x] 4.1 ADR 0009 `docs/adr/0009-dateizugriff-explorer.md`

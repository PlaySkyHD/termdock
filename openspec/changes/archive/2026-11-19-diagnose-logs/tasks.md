# Tasks

## 1. Logger und Schwärzung

- [x] 1.1 Test und Umsetzung: `redact` für jede Form (Env-Name, Env-Wert, Authorization, `ghp_`, `github_pat_`, `sk-`, `xox`) und ein Gegenbeispiel ohne Fehltreffer (`log/redact.test.ts`)
- [x] 1.2 Test und Umsetzung: `createLogger` (Zeilenformat, Rotation an der Grenze, höchstens zwei Dateien, vorhandene Datei, Schreibfehler wirft nie und erholt sich, werfender Mirror) (`log/logger.test.ts`)

## 2. Core

- [x] 2.1 `runCore` loggt über den Logger nach `<Datenordner>/logs/core.log` und stderr, wartet beim Abbau auf `flush()`; ein zweiter Core schreibt nur nach stderr (`bin/run-core.test.ts`: kaputte Datenbank, Backend-Warnung, `already_running` legt den Datenordner nicht an)
- [x] 2.2 Registry: `onListenerError` statt `console.error` im Core (`session/registry.ts`, geprüft über den Start in 2.1 und den Typecheck)

## 3. Desktop

- [x] 3.1 `main/diagnostics.ts`: `createDesktopLogger`, `openLogFolder`, `helpMenuTemplate` (`main/diagnostics.test.ts`)
- [x] 3.2 `main/main.ts`: Logger, `render-process-gone`, `coreClosed`, Menü „Hilfe“ (geprüft durch Typecheck und 3.1; das native App-Menü ist im Screenshot-Modus nicht abbildbar)

## 4. Dokumentation

- [x] 4.1 ADR 0001: Log-Ort und -Grenzen (geprüft durch `npm run format:check`)

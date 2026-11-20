# Proposal

## Why

Fehler aus Core und Desktop-App sind nach dem Vorfall nicht mehr nachlesbar: Der Core schreibt nach stderr, die Desktop-App startet ihn aber mit `stdio: "ignore"`, und der Main-Prozess der App schreibt ebenfalls nur nach stderr (#129, Konzept Phase 4, Abschnitt 12).

## What Changes

- Neues Modul `packages/core/src/log/` mit `createLogger({ file, maxBytes, files })` und `redact(text)`; die Desktop-App nutzt dasselbe Modul über `@termdock/core`.
- Der Core schreibt seine Meldungen zusätzlich nach `<Datenordner>/logs/core.log`, der Desktop-Main-Prozess nach `<Datenordner>/logs/desktop.log` (Startfehler des Cores, `coreClosed`, `render-process-gone`). stderr bleibt erhalten.
- Jede Datei rotiert ab 1 MiB auf `<name>.1.log`, höchstens 2 Dateien je Prozess. Schreiben ist asynchron; ein Fehler dabei wirft nie.
- Vor dem Schreiben ersetzt `redact` bekannte Geheimnisformen durch `«redacted»`.
- Menü „Hilfe“ mit dem Eintrag „Log-Ordner öffnen“.
- Das Registry nimmt `onListenerError` an, damit auch dieser bisherige `console.error`-Aufruf im Log landet.
- ADR 0001 nennt Log-Ort und -Grenzen.

## Capabilities

### New Capabilities

- `diagnostics`: Diagnose-Logs von Core und Desktop mit Rotation, Schwärzung und Menüeintrag.

### Modified Capabilities

(keine)

## Impact

`packages/core` (neu: `log/`; geändert: `bin/run-core.ts`, `session/registry.ts`, `index.ts`), `apps/desktop` (neu: `main/diagnostics.ts`; geändert: `main/main.ts`), `docs/adr/0001-core-prozess-und-lebensdauer.md`. Protokoll und IPC bleiben unverändert.

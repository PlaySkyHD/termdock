# Proposal

## Why

Der Datei-Explorer (#198) zeigt das aktuelle Verzeichnis einer Session und lässt Dateien umbenennen, verschieben, löschen, herunterladen, im Windows-Explorer zeigen und öffnen. Dafür braucht die Desktop-App einen Dateizugriff, der WSL-Distros und Windows-Laufwerke gleich behandelt und dem Renderer nur eine schmale, geprüfte Brücke gibt (ADR 0006). Dieser Change legt den Dienst im Main-Prozess und die Brücke an; die Oberfläche folgt mit #202 und #203.

## What Changes

- ADR 0009: Dateizugriff im Desktop-Main über Node-`fs/promises`, WSL-Pfade als `\\wsl.localhost\<distro>\<pfad>`, Verzicht auf `fs.watch` und auf `wsl.exe --exec`, endgültiges Löschen, keine Netzwerkpfade außer `\\wsl.localhost`.
- Neues Modul `file-paths.ts` (reine Prüfung und Übersetzung der Orte) und `file-service.ts` (`list`, `rename`, `move`, `delete`, `download`, `reveal`, `open`), Ergebnisse als `{ ok: true, … }` oder `{ ok: false, code }` mit `ENOENT`, `EACCES`, `EEXIST`, `EINVAL`, `OTHER`.
- Eigener Kanal `termdock:files` mit `FileBridge` im Main, der jede Anfrage des Renderers prüft; `window.termdock.files` im Preload.
- Neue Capability `file-explorer`.

## Capabilities

### New Capabilities

- `file-explorer`: Dateizugriff des Explorers (Orte und Prüfung, Auflisten, Ändern, Herunterladen, Zeigen und Öffnen, Brücke).

### Modified Capabilities

(keine)

## Impact

- Paket `apps/desktop` (Main, Preload, `shared/files.ts`), `docs/adr/0009-dateizugriff-explorer.md`. Keine neue Dependency.
- Brücke Renderer ↔ Main: ein neuer Kanal `termdock:files` mit sieben Aufrufen; `termdock:call` bleibt unverändert.
- Kein Vertragswechsel mit dem Core: `packages/protocol` und `packages/core` bleiben unverändert; der Dienst fragt nur `wsl.distros`.
- Non-Goals: Oberfläche (Panel #202, Aktionen #203), Dateiwächter, Papierkorb, Hochladen nach WSL, Kopieren und Verschieben zwischen Backends.
- Security: Pfade und Namen aus dem Renderer werden im Main geprüft (absolut, Länge, Steuerzeichen, `..`, Distro bekannt); keine Shell-Strings; `open` startet keine Programme; Antworten und Logs enthalten keine Pfade und keine Meldungen des Betriebssystems.
- Breaking Changes: keine.

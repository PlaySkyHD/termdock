# Proposal

## Why

ADR 0002 und `security.instructions.md` verlangen, dass die Core-Pipe nur für den aktuellen Windows-Benutzer zugänglich ist. Issue #14 vermutet, dass der Standard-Sicherheitsdeskriptor von libuv Fremden zu viel erlaubt. Die Messung auf dem Host (siehe `design.md`) zeigt: Fremde Konten haben nur Lesezugriff, kein Schreibrecht. Eine vollständige Beschränkung auf den Benutzer ist ohne Native-Code nicht möglich. Dieser Change belegt den Ist-Zustand mit einem Regressionstest, schließt die Lücke offener Verbindungen ohne Handshake und formuliert Spec und ADR so, wie es tatsächlich gilt.

## What Changes

- Der Core trennt Verbindungen, die nicht innerhalb von 5 s ein gültiges `hello` senden (Option `helloTimeoutMs`).
- Neues Modul `packages/core/src/ipc/pipe-acl.ts`: liest die DACL aus SDDL-Text (reine Logik).
- Windows-Test, der die DACL der echten Core-Pipe prüft: Kein Konto außer Benutzer, SYSTEM und Administratoren hat Schreibzugriff.
- Spec `core-ipc`: zwei neue Anforderungen (Zugriffsrechte der Pipe, Hello-Frist).
- ADR 0002: Transportzeile präzisiert (Rechte, Restrisiko, Folge-Option).
- Keine Breaking Changes, keine neue Dependency. Exporte am Ende von `packages/core/src/index.ts`.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `core-ipc`: Zugriffsrechte der Pipe und Frist für den Handshake.

## Impact

- `packages/core/src/ipc/server.ts` (nur Verbindungsannahme und Hello-Timer), neue Dateien `ipc/pipe-acl.ts`, `ipc/pipe-acl.test.ts`, Tests in `ipc/ipc.test.ts`, `docs/adr/0002-ipc-vertrag.md`.
- Unverändert: `packages/protocol`, Registry, Backends, `bin/run-core.ts`.

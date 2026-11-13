# Tasks

## 1. Messung und Entscheidung

- [x] 1.1 DACL einer Node-Pipe auf Windows messen (READ_CONTROL, `GetSecurityInfo`, SDDL) und in `design.md` festhalten
- [x] 1.2 Varianten (a), (b), (c) bewerten, `readableAll`/`writableAll` messen, Entscheidung begründen

## 2. Umsetzung

- [x] 2.1 Test-first: Hello-Frist (`ipc.test.ts`: Verbindung ohne hello wird getrennt, Verbindung nach hello bleibt offen)
- [x] 2.2 `helloTimeoutMs`, `helloTimer` in `ipc/server.ts` (Annahme, `greet`, `onClose`)
- [x] 2.3 `ipc/pipe-acl.ts` (`parseDacl`, `foreignAllowEntries`, `grantsWrite`) mit Unit-Tests
- [x] 2.4 Windows-Test der DACL der echten Pipe (`describe.skipIf(process.platform !== "win32")`)
- [x] 2.5 Exporte unter `// pipe security` am Ende von `packages/core/src/index.ts`

## 3. Dokumentation

- [x] 3.1 ADR 0002: Transportzeile und Folgen präzisiert
- [x] 3.2 Spec `core-ipc` per Archivierung ergänzt, Purpose geprüft

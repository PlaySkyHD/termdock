# Tasks

## 1. Zustandsautomat

- [x] 1.1 `CoreError` mit `code: ErrorCode` in `packages/core/src/session/errors.ts` anlegen und über `src/index.ts` exportieren; prüfen mit `npm run typecheck`
- [x] 1.2 `transition`/`canTransition` in `packages/core/src/session/lifecycle.ts` test-first umsetzen; `lifecycle.test.ts` prüft alle erlaubten und mehrere verbotene Übergänge

## 2. FakeBackend

- [x] 2.1 `FakeBackend` und `FakePty` in `packages/core/src/backend/fake.ts` anlegen (Ausgabe, PTY-Ende, `exists`, Snapshot, Startfehler steuern; Eingaben, Resizes, Starts, Attaches, Kills auslesen); geprüft über die Registry-Tests in 3.x

## 3. Session Registry

- [x] 3.1 Anlegen und Starten (UUID, `Starting → Running → Detached`, Startfehler → `Interrupted`); Test in `registry.test.ts`
- [x] 3.2 Views anhängen/trennen mit `Running` ↔ `Detached`; Test in `registry.test.ts`
- [x] 3.3 Eingabe-Lock mit zwei und drei Views, `claimWriter`, kein automatischer Nachfolger; Test in `registry.test.ts`
- [x] 3.4 Resize-Autorität und Größenereignis; Test in `registry.test.ts`
- [x] 3.5 Ausgabeverteilung und 256-KiB-Puffer als Snapshot-Fallback; Test in `registry.test.ts`
- [x] 3.6 PTY-Ende mit und ohne Exit-Code; Test in `registry.test.ts`
- [x] 3.7 `kill`, `restart` (inklusive Wiederanbinden bei vorhandener Backend-Session) und `archive`; Test in `registry.test.ts`
- [x] 3.8 Öffentliche API in `packages/core/src/index.ts` exportieren; prüfen mit `npm run typecheck`

## 4. Integration

- [x] 4.1 `npm run typecheck`, `npm run format:check` und `npm test -w packages/core` sind grün; `eslint packages` ist grün (`npm run lint` meldet nur vorbestehende Fehler in `.claude/hooks/retro-after-pr.mjs` aus `main`)

## Workflow follow-up

- Change im selben Branch archivieren und `openspec validate --specs --strict` ausführen.

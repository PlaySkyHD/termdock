# Tasks

## 1. Frame-Codec (Test zuerst, `src/frame.test.ts`)

- [x] 1.1 `encodeFrame`/`FrameDecoder`: Roundtrip
- [x] 1.2 Frame über mehrere Chunks (auch byteweise) und mehrere Frames pro Chunk
- [x] 1.3 Header über 1 MiB und Nutzdaten über 4 MiB sind Protokollfehler; Grenzwerte erlaubt
- [x] 1.4 Kaputtes JSON, Nicht-Objekt-Header; Decoder bleibt nach Fehler unbrauchbar

## 2. Nachrichten und Guards (Test zuerst, `src/guards.test.ts`)

- [x] 2.1 `parseRequest`: gültige Anfragen, unbekannte Methode, fehlende Pflichtfelder, Nutzdatenregeln
- [x] 2.2 `parseResponse`: Ergebnis je Methode, Fehlerantwort, unbekannter Fehlercode, Snapshot-Nutzdaten bei `session.attach`
- [x] 2.3 `parseEvent`: alle vier Events, Nutzdaten bei `session.output`
- [x] 2.4 `negotiateHello`: gleiche und falsche Hauptversion, ungültiges Format

## 3. Abschluss

- [x] 3.1 Export in `src/index.ts`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test -w packages/protocol` grün
- [x] 3.2 Change archivieren und `openspec validate --specs --strict`

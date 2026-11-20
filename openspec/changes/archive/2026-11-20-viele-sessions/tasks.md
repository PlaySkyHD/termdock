# Tasks

## 1. Backend-Schnittstelle und WSL

- [x] 1.1 `listLive` als optionales Mitglied in `backend/types.ts`, `FakeBackend` mit Option `listLive`, `existsCalls` und `listLiveCalls`; geprüft durch `session/restore-live.test.ts`
- [x] 1.2 Test und Umsetzung: `listSessionsArgs` als Argument-Array und Parser `parseLiveSessions` (`backend/wsl/commands.test.ts`)
- [x] 1.3 Test und Umsetzung: `WslBackend.listLive` mit einem Aufruf je Distro, leere Menge ohne Server, `undefined` bei einem Fehler, Keepalive-Buchführung wie `exists` mit genau einer Übernahme (`backend/wsl/backend.test.ts`)
- [x] 1.4 WSL-Integrationstest: `listLive` liefert genau die lebenden Sessions (ohne tote Pane und fehlende), stimmt mit `exists` überein, leere Menge auf einem Socket ohne Server (`backend/wsl/backend.wsl.test.ts`)

## 2. Abgleich

- [x] 2.1 Test und Umsetzung: Der Abgleich fragt `listLive` einmal je erreichbarem Backend, lebend → `Detached`, fehlend → `Interrupted`, `undefined` oder Fehler → `exists` je Session, kein Aufruf für nicht erreichbare Backends, Windows- und beendete Sessions, nichts geändert nach dem Ende des Core (`session/restore-live.test.ts`); die bisherigen Tests in `session/restore.test.ts` bleiben grün

## 3. Lasttest und Grenzwerte

- [x] 3.1 Test und Umsetzung: `scripts/load-test.mjs` mit Optionen, Perzentil, Grenzwertprüfung, Tabelle, Socket nach dem Schema `termdock-test-<pid>-<nonce>` und gedrosseltem Ausgabeprogramm als Argument-Array (`scripts/load-test.test.mjs` in `npm run test:hooks`)
- [x] 3.2 Lauf mit 50 Sessions vor und nach der Bündelung, Messwerte im PR und im Design; geprüft durch den Lauf selbst (Exit-Code, Aufräumen von Socket, Core und Datenordner)
- [x] 3.3 Renderer geprüft: kein WebGL-Addon in `apps/desktop` (DOM-Renderer von xterm.js), also kein Verlust von WebGL-Kontexten bei vielen Tabs; geprüft durch `npm test -w apps/desktop` (unverändert grün)

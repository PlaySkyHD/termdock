# Tasks

## 1. Protokoll

- [x] 1.1 Test und Umsetzung: Event `session.created` mit Guard, Version `1.2` (`guards.test.ts`, `messages.ts`, `guards.ts`, `model.ts`)

## 2. Core

- [x] 2.1 Test und Umsetzung: `SessionRegistry.onCreated` meldet `create` einmal, bei fehlgeschlagenem Speichern nichts, `restore` nichts (`restore.test.ts`, `registry.ts`)
- [x] 2.2 Test und Umsetzung: Server sendet `session.created` an alle Verbindungen, vor der Antwort; zwei Clients (`ipc.test.ts`, `server.ts`)

## 3. Desktop

- [x] 3.1 Test und Umsetzung: Brücke leitet `session.created` an alle Fenster, keine eigene Meldung mehr (`bridge.test.ts`, `bridge.ts`)
- [x] 3.2 Test: `session-sync` zeigt eine Session nur einmal bei doppeltem Event, Liste und Antwort von `createSession` (`session-sync.test.ts`)

## 4. Dokumentation

- [x] 4.1 ADR 0002 nennt 1.2 und das Verhalten älterer Clients

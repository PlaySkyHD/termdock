# Design

## Context

Die Registry kennt neue Sessions an zwei Stellen: `create` und der Reconcile beim Start (`restore`, ADR 0005). Der Server verteilt Events über `route`; `session.stateChanged` geht an Views und Listen-Clients. Der Store im Renderer ist bereits idempotent (`sessionCreated` ignoriert bekannte IDs, `session-sync` hält Events bis zur ersten Liste zurück).

## Goals / Non-Goals

**Goals:** Eine von einem beliebigen Client angelegte Session erscheint in allen Fenstern ohne Neuladen; keine doppelte Session.

**Non-Goals:** Attach-Ergebnis und Snapshot, `terminal-controller.ts`, ein Event für gelöschte oder archivierte Sessions.

## Decisions

- **Auslöser nur in `create`.** `SessionRegistry.onCreated` meldet die Session direkt nach dem Eintragen in die Registry und vor dem Start, also im Zustand `Starting`. Dadurch kommt jedes spätere `session.stateChanged` nach dem Event, und ein Client kennt die Session, bevor er Zustandswechsel für sie sieht. Fehlgeschlagenes Speichern wirft vor dem Eintragen, dann gibt es kein Event. `restore` meldet nichts: Es läuft vor dem `ready` des Servers, und Clients lesen den Stand mit `session.list`; eine zweite Meldung wäre eine Doppelung. Es gibt keinen weiteren Pfad, über den eine Session neu in die Registry kommt. Der Autostart von Profilen (ADR 0005) ist noch nicht gebaut; er legt Sessions über `create` an und wird damit ohne Zutun gemeldet, nach dem Reconcile und höchstens einmal je Session.
- **Empfänger: Verbindungen, die `session.list` genutzt haben.** Die Session hat noch keine Views; `session.stateChanged` geht an dieselben Clients. Ein Client ohne `session.list` bekäme sonst eine Session in `Starting`, deren Zustandswechsel er nie sieht. Die Desktop-Brücke ist vor jedem Anlegen Listen-Client: Jedes Fenster listet beim Start, bevor es etwas anlegen kann; die Antwort von `createSession` deckt den Rest ab. Fehlgeschlagener Start: Die Session besteht dann (`Interrupted`), das Event geht trotzdem raus und `session.stateChanged` folgt; „abgelehnt“ heißt vor dem Eintragen (`bad_request`, Shutdown, Speicherfehler). Ein werfender Listener der Registry bricht `create` nicht ab: `ListenerSet.emit` meldet den Fehler auf stderr. Der Anleger bekommt das Event auch; es steht vor seiner Antwort, weil der Server es beim Eintragen schreibt und die Antwort erst nach dem Start. Hält die Verbindung gerade ein Attach, wartet das Event wie alle anderen (`held`).
- **Ältere Clients.** ADR 0002: nur die Hauptversion entscheidet. Die Client-Bibliothek verwirft Events, die `parseEvent` nicht kennt, ohne Fehler; der Core filtert deshalb nicht nach der Version des Clients. Alternative: Version je Verbindung merken und das Event nur ab 1.2 senden; verworfen, weil es Zustand ohne Nutzen hinzufügt.
- **Idempotenz im Renderer.** Das Event trägt den Zustand `Starting`; die Antwort von `session.create` kann `Running` tragen. Der Store behält, was er hat (kein Rückschritt), und `session.stateChanged` bringt den neuen Zustand. Der bestehende Store und `session-sync` genügen; neue Tests belegen es.
- **Brücke.** `core.on("session.created")` ruft `toAll({ kind: "sessionCreated" })`. Der Aufruf `createSession` gibt nur noch die Antwort zurück.

## Risks / Trade-offs

- Ein Event vom Anleger kann vor seiner Antwort in den Fenstern ankommen: gewollt, der Store ist idempotent.

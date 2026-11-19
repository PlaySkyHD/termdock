# Proposal

## Why

Volle Screenshot-Läufe scheiterten in der Runde PRs #119–#126 immer wieder in Szenen, die der jeweilige Diff nicht berührte (#127): „vim before: cursor at 0,0“, „no stty answer in pane“ und ein Fehler mit der Meldung `[object Object]` in den Tastenkürzel-Szenen. Die Szenen lasen den Endzustand einmal oder warteten feste Zeiten; unter Last, etwa bei parallelen Läufen mehrerer Agents, reicht das nicht. Der Nachlauf kostete Agents Stunden.

## What Changes

- **Szenen warten auf einen beobachtbaren Endzustand** mit Zeitlimit und Meldung, die den letzten gesehenen Zustand nennt: vim zeigt die Zeile 150 im Lineal, bevor der Cursor verglichen wird, und der Vergleich liest tmux bei jedem Versuch neu; `stty size` ist erst fertig, wenn eine neue Antwort im Pane steht; die Zwischenablage der Tastenkürzel-Szene wird mit Fokus im Fenster wiederholt beschrieben.
- **Lesbare Fehler:** Fehler, die keine `Error`-Objekte sind (etwa `DOMException` oder einfache Objekte aus `executeJavaScript`), erscheinen mit Namen und Meldung statt als `[object Object]`.
- **Wiederholung:** Scheitert eine Szenengruppe, setzt der Lauf den Zustand zurück (Fenster, Sessions) und spielt diese Gruppe genau einmal neu, loggt `retry <gruppe>: <fehler>` und nennt Wiederholungen am Ende in der Zusammenfassung. Scheitert auch die Wiederholung, endet der Lauf mit Code 1.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `desktop-shell`: Anforderung „Screenshot-Modus wählt Szenengruppen“ um die einmalige Wiederholung erweitert (MODIFIED).

## Impact

- `apps/desktop/src/main/screenshot.ts` (reine Funktionen `describeError`, `runGroupsWithRetry`, `SceneGroupError`), `screenshot-scenario.ts`, `main.ts`; Tests in `screenshot.test.ts`; `docs/agent-lessons-learned.md`.

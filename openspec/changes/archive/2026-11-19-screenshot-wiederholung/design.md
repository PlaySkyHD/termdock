# Design

## Entscheidungen

- **Reine Funktion für die Wiederholung.** `runGroupsWithRetry(groups, play, reset, log)` in `screenshot.ts` spielt die Gruppen. `play` wirft bei einem Fehler eine `SceneGroupError` mit der Gruppe, in der er auftrat (`runScenario` merkt sich die laufende Gruppe; der gemeinsame Aufbau von `scenario`, `sidebar`, `restore` und `quit` zählt zur ersten gewählten dieser Gruppen). Die Funktion loggt `retry <gruppe>: <fehler>`, ruft `reset` und spielt die gescheiterte und alle folgenden Gruppen neu. Jede Gruppe wird höchstens einmal wiederholt; ein zweiter Fehler derselben Gruppe wird weitergeworfen. Fehler ohne Gruppe (Aufbau des Laufs) werden nicht wiederholt.
- **Zurücksetzen ohne neuen Core.** Zwischen Versuch und Wiederholung schließt der Lauf alle Fenster (auch aus dem Layout) und beendet und löscht alle Sessions des isolierten Cores. Jede Gruppe bringt ihren Aufbau selbst mit, die Wiederholung beginnt also sauber. Ein eigener Core pro Gruppe wäre sicherer, kostet aber jeweils mehrere Sekunden Start und ändert den Ablauf der vollen Läufe.
- **Warten auf Endzustände statt feste Zeiten.** Der Lauf liest den Zustand wiederholt (alle 100 bis 250 ms) bis zum Zeitlimit und meldet bei Ablauf, was er zuletzt sah. Das gilt für den vim-Cursor (tmux wird bei jedem Versuch neu gelesen, vorher muss das Lineal die Zeile 150 zeigen), für die Antwort von `stty size` (die Zahl der Antwortzeilen im Pane muss wachsen) und für die Zwischenablage.
- **Fehlertext:** `describeError` formt Fehler aller Art in Text (`name: message`, bei einfachen Objekten ihre Felder als JSON).

## Keine neuen Abhängigkeiten

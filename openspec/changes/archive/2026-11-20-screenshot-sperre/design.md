# Design

## Entscheidungen

- **Sperrdatei statt Mutex oder Pipe.** `fs.openSync(path, "wx")` ist unter Windows atomar (`CREATE_NEW`) und braucht keine Abhängigkeit. Die Datei liegt in `os.tmpdir()` des Benutzers, also gilt die Sperre für alle Läufe dieses Windows-Benutzers, auch aus verschiedenen Worktrees. Der Name `termdock-screenshot.lock` passt nicht auf das Muster der Profile (`termdock-screenshot-profile-<pid>`), `staleProfileDirs` lässt ihn liegen.
- **Reine Funktionen mit eingespeistem Dateisystem.** `screenshotLockState(entry, ownPid, isAlive)` entscheidet aus Inhalt und Alter, ob die Sperre frei ist oder wem sie gehört. `tryScreenshotLock` versucht das exklusive Anlegen, entfernt eine verwaiste Sperre und versucht es erneut. `acquireScreenshotLock` wartet mit `sleep` und `now` bis zum Zeitlimit und loggt bei jedem neuen Halter einmal `waiting for screenshot run <pid>`. Tests ersetzen Dateisystem, `isAlive`, `sleep` und `now`.
- **Wann eine Sperre verwaist ist.** Der Prozess der PID lebt nicht (`isAlive` wie in `staleProfileDirs`); oder der Inhalt ist keine Zahl und die Datei älter als 5 s (ein Lauf starb zwischen Anlegen und Schreiben); oder die Datei ist älter als 12 min. Die letzte Regel fängt eine wiederverwendete Windows-PID ab: Ein Lauf hält die Sperre höchstens etwa 480 s Szenen plus Core-Start und Aufräumen, deutlich unter 12 min; ein Wartender sieht eine solche Sperre also vor seinem eigenen Zeitlimit von 15 min als frei.
- **Freigabe nur der eigenen Sperre.** `releaseScreenshotLock` entfernt die Datei nur, wenn sie die eigene PID enthält, damit ein Lauf, dessen Sperre als verwaist ersetzt wurde, nicht die Sperre des nächsten löscht.
- **Wartezeit außerhalb des Laufzeitlimits.** Die Sperre wird in `main()` vor `connectOrStartCore` genommen; der Wächter `SCREENSHOT_TIMEOUT_MS` startet erst in `runScreenshot`. Ein Lauf, der nach 15 min aufgibt, hat keinen Core und kein Fenster; er wartet auf das Aufräumen alter Sockets, entfernt sein Temp-Verzeichnis und endet mit Code 1.
- **Bekannte Lücke:** Sehen zwei Läufe gleichzeitig dieselbe verwaiste Sperre, kann der zweite die gerade neu angelegte Sperre des ersten entfernen, bevor er seine eigene anlegt. Das Fenster ist ein einziger Dateizugriff und nur nach einem abgebrochenen Lauf offen; im schlimmsten Fall laufen zwei Läufe parallel wie bisher.

## Keine neuen Abhängigkeiten

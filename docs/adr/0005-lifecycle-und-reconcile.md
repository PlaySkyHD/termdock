# ADR 0005: Session-Lifecycle und Rekonstruktion beim Start

Status: angenommen (13.11.2026)

## Kontext

Kapitel 6 definiert die Zustände `Starting`, `Running`, `Detached`, `Exited`, `Interrupted`, `Archived`. Verlorene Prozesse müssen als `Interrupted` statt `Running` erscheinen (Abnahme 9), Autostarts dürfen nicht doppelt laufen (Abnahme 7, 14).

## Entscheidung

- **Zustandsautomat** (einzige Quelle: `packages/core/src/session/lifecycle.ts`), erlaubte Übergänge:
  - `Starting → Running | Interrupted | Exited`
  - `Running ↔ Detached` (`Running` = mindestens eine View angehängt, `Detached` = Prozess lebt, keine View)
  - `Running | Detached → Exited` (Prozess endet selbst oder wird über `session.kill` beendet)
  - `Running | Detached → Interrupted` (PTY/tmux verschwindet unerwartet, oder Reconcile findet ihn nicht)
  - `Exited | Interrupted → Starting` (Neustart derselben Session-ID, über `session.restart` aus der App oder den Autostart; eine noch lebende tmux-Session wird angebunden; erste Ausgabe eines neu gestarteten Laufs ist die Trennzeile `--- Neu gestartet <ISO-Zeit> ---`, ein angebundener läuft ohne sie weiter, #156)
  - `Exited | Interrupted | Detached | Running → Archived` (bei laufendem Prozess wird er zuerst beendet)
  - Alle anderen Übergänge sind `invalid_state`.
- **Ändern und Löschen (#57):** `update` ändert Name, Workspace (`null` = gruppenlos) und Verlauf-Schalter in jedem Zustand, ohne Prozess und Zustand zu berühren. `delete` ist kein Zustand, sondern das Ende der Session, und nur aus `Exited`, `Interrupted` oder `Archived` erlaubt (sonst `invalid_state`). Reihenfolge: bei `Interrupted` eine noch existierende Backend-Session beenden (keine verwaiste tmux-Session; scheitert die Prüfung, `backend_unavailable` und nichts gelöscht, wie beim Archivieren), Verlauf entfernen, Zeile entfernen, dann alle Views trennen (Schreiberwechsel ohne Schreiber) und die Session vergessen. Scheitert ein Schritt, bleibt die Session mit Views und Zeile; schon Entferntes (etwa der Verlauf) bleibt entfernt, ein erneutes `delete` erledigt den Rest. `session.removed` geht an Listen-Clients und an jede Verbindung mit einer View der Session. Währenddessen sind Anhängen, Ändern und alle Lifecycle-Aufrufe `invalid_state`.
- **Reconcile beim Core-Start:** Für jede gespeicherte Session in `Starting`, `Running` oder `Detached`:
  - WSL: `exists()` true → neu anbinden, Zustand `Detached`; false → `Interrupted`. Die Existenz fragt der Core je Backend gebündelt mit `listLive()` ab (WSL: ein `tmux list-sessions` je Distro, #134); ohne Antwort `exists()` je Session.
  - Windows: immer `Interrupted` (PTY gehörte dem alten Core).
  - Ist WSL selbst nicht erreichbar, werden die WSL-Sessions `Interrupted` und der Core meldet `backend_unavailable` in der Statusleiste.
- **Autostart (#61, `session/autostart.ts`):** Nur der Core startet Autostart-Profile, nur einmal pro Core-Start, nach dem Reconcile; keine IPC-Methode löst ihn aus. Hat ein Profil schon eine lebende Session (`Starting`/`Running`/`Detached`, Bindung über `profileId`), wird nicht neu gestartet. Sonst wird die zuletzt geänderte Session in `Exited` oder `Interrupted` per `restart` unter ihrer ID fortgesetzt (gleicher Platz in der Sidebar, Verlauf läuft weiter), damit sich nach Windows-Neustarts keine alten Sessions ansammeln; nur ohne solche Session (oder mit nur `Archived`) wird eine neue angelegt wie `session.create { name, profileId }`. Backends, die der Reconcile erreicht hat, prüft der Autostart nicht erneut. Anfragen warten, bis die Autostart-Sessions eingetragen sind, damit jeder Client sie in seiner ersten Liste sieht und kein Aufruf parallel läuft. Ein fehlendes oder nicht erreichbares Backend wird einmal auf stderr und in `core.status` gemeldet, seine Profile bekommen keine Session; ein gescheiterter Start wird `Interrupted` und einmal gemeldet. Keine Wiederholung.
- **Eingabe-Lock:** Pro Session höchstens eine schreibende View. Die erste angehängte View wird Schreiber. `session.claimWriter` überträgt das Recht atomar und sendet `view.writerChanged` an alle Views. Trennt sich der Schreiber, wird keine andere View automatisch Schreiber.

## Nachtrag: Windows-Sessions (#65, 24.11.2026)

- **Lebensdauer:** Eine Windows-Session lebt, solange ihre Shell im Core läuft. Endet die Shell, wird sie `Exited` mit dem Exit-Code der Shell; verliert der Core ihre Ausgabe (ADR 0008), wird sie `Interrupted`. Ein Wiederanbinden gibt es nicht: `exists` ist danach falsch.
- **Ende des Core:** Auch `core.shutdown { stopSessions: false }` und SIGINT/SIGTERM beenden die Shells, denn sie überleben den Core nicht (ADR 0001). Der gespeicherte Zustand bleibt dabei stehen (`Running` oder `Detached`), wie bei jedem Abbau ohne Stop; der nächste Core macht daraus beim Abgleich ohne Backend-Aufruf `Interrupted`. Dasselbe gilt nach einem Absturz oder hartem Kill des Core.
- **Neustart:** `session.restart` und der Autostart starten eine neue Shell unter derselben ID, mit der Trennzeile `--- Neu gestartet <ISO-Zeit> ---` vor der ersten Ausgabe; der Verlauf läuft weiter. Autostart-Profile mit Backend `windows` laufen wie WSL-Profile einmal je Core-Start.
- **Archivieren und Löschen:** Archivieren beendet die laufende Shell; Löschen ist nur ohne laufenden Prozess erlaubt, eine `Interrupted`-Windows-Session hat keine Backend-Session mehr.
- **Fehlertext:** Scheitert ein Start mit einem `CoreError` des Backends (z. B. fehlt `pwsh.exe`), hängt die Registry dessen Text an „Session … could not be started“ an. Andere Fehler bleiben in `cause`, weil sie Befehlszeilen enthalten können.
- **UI:** Sidebar, Statusleiste, Tooltip, Formular, Projektdialog und Schließen-Dialog nennen die Grenze („Läuft nur, solange der TermDock-Core läuft“); eine `Interrupted`-Windows-Session sagt, dass die Shell mit dem Core beendet wurde.

## Folgen

- Wiederherstellen einer Oberfläche setzt keine gestoppten Programme fort. Das wird in der UI nicht als `Running` dargestellt.

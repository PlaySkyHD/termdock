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
  - `Exited | Interrupted → Starting` (Neustart derselben Session-ID)
  - `Exited | Interrupted | Detached | Running → Archived` (bei laufendem Prozess wird er zuerst beendet)
  - Alle anderen Übergänge sind `invalid_state`.
- **Reconcile beim Core-Start:** Für jede gespeicherte Session in `Starting`, `Running` oder `Detached`:
  - WSL: `exists()` true → neu anbinden, Zustand `Detached`; false → `Interrupted`.
  - Windows: immer `Interrupted` (PTY gehörte dem alten Core).
  - Ist WSL selbst nicht erreichbar, werden die WSL-Sessions `Interrupted` und der Core meldet `backend_unavailable` in der Statusleiste.
- **Autostart:** Nur der Core startet Autostart-Profile, nur einmal pro Core-Start, nach dem Reconcile. Hat ein Profil schon eine lebende Session (`Running`/`Detached`), wird nicht neu gestartet.
- **Eingabe-Lock:** Pro Session höchstens eine schreibende View. Die erste angehängte View wird Schreiber. `session.claimWriter` überträgt das Recht atomar und sendet `view.writerChanged` an alle Views. Trennt sich der Schreiber, wird keine andere View automatisch Schreiber.

## Folgen

- Wiederherstellen einer Oberfläche setzt keine gestoppten Programme fort. Das wird in der UI nicht als `Running` dargestellt.

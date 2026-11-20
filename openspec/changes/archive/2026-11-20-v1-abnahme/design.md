# Design

## Kontext

#132 verlangt für jedes V1-Kriterium einen benannten Nachweis und eine Prüfung in der CI. Die CI läuft auf `windows-latest` ohne WSL; WSL-Tests und Screenshot-Läufe laufen nur lokal.

## Entscheidungen

- **Format der Übersicht.** Eine Tabelle oben (Nummer, Text, Status) und je Kriterium ein Abschnitt `### V1-<nn>: <text>` mit `Status:` und einer Liste `- Test …`, `- Szene …`, `- Manuell: …`. Das Skript liest beides und prüft, dass Tabelle, Abschnitt und Konzept denselben Text und Status haben. So bleibt die Übersicht lesbar und maschinenprüfbar ohne zweites Format (kein YAML, keine neue Abhängigkeit).
- **Kriterien aus dem Konzept.** Das Skript liest die Kriterien aus `docs/concept/v1-konzept.txt`, Abschnitt 10. Die Zählung läuft von 01; die nächste nummerierte Zeile, die nicht das nächste Kriterium ist, beendet den Abschnitt (die Überschrift „11. Technische Risiken“ steht hinter Kriterium 15, „11. Das Speicherlimit …“ ist Kriterium 11).
- **Prüfung in beide Richtungen.** Jeder genannte Testname muss als String-Literal in der genannten Datei stehen und das Präfix seines Kriteriums tragen; umgekehrt muss jeder Test mit `[V1-<nn>]` in `packages/` und `apps/` unter seinem Kriterium stehen. Eine Umbenennung ohne Nachtrag fällt so in der CI auf. `scripts/` wird nicht durchsucht, weil die Tests des Skripts selbst Präfixe als Testdaten enthalten.
- **Status.** `automatisiert`, `automatisiert und manuell`, `manuell` oder `offen, #<issue>`. Nur ein offenes Kriterium darf ohne Nachweis sein; die übrigen Status müssen zu den Nachweisen passen.
- **Szenen.** Screenshot-Szenen gelten als Nachweis, wenn die genannte Datei den Bildnamen in Anführungszeichen enthält. Ob das Bild stimmt, prüft ein Mensch; der Lauf selbst endet mit Code 1, wenn ein erwarteter Zustand ausbleibt.
- **03 mit `vim`.** Claude Code und Codex brauchen Logins und Netz; sie sind ein manueller Schritt. `vim -u NONE -N -n` ist auf der Distro vorhanden und zeichnet wie die CLIs im Alternate Screen. Der Test prüft `#{alternate_on}` über tmux (tmux selbst läuft im Alternate Screen der View), verlässt den Einfügemodus mit Strg+C statt ESC (keine Wartezeit auf eine Escape-Sequenz) und wartet auf beobachtbare Zustände (`-- INSERT --`, Zustand `Exited`), nie auf feste Zeiten.
- **12 als WSL-Test.** Die Unit-Tests decken Verschieben, Archivieren und Löschen einzeln ab; der neue Test geht den ganzen Weg gegen tmux und prüft über `#{pane_pid}`, dass das Verschieben den Prozess nicht berührt. Die Szenarien dafür stehen schon in `session-lifecycle` („Session ändern“, „Archivieren“) und `session-persistence`; es kommt keine neue Anforderung dazu.
- **14 ohne WSL.** Doppelte Autostarts entstehen nur, wenn zwei Cores laufen; alle Fenster einer App teilen einen Main-Prozess und eine Verbindung (Single-Instance-Lock). Der neue Test startet zwei `runCore` gleichzeitig mit `FakeBackend` und läuft so in der CI. Der Start zweier App-Instanzen bleibt ein manueller Schritt.
- **Konflikte mit PR #148.** Testnamen in `backend.test.ts`, `commands.test.ts`, `keepalive*.ts` und `keepalive.wsl.test.ts` bleiben unverändert; keines der Kriterien hängt allein an ihnen.

## Risiken

- Die Suche nach `[V1-<nn>]` ist ein regulärer Ausdruck über `it(`/`test(` mit String-Literal. Ein Name aus einer Variablen oder einem Template mit Platzhaltern wird nicht erkannt; solche Namen sollen keine Nachweise sein.
- Der WSL-Test für 03 setzt `vim` in der Distro voraus. Fehlt es, scheitert der Test mit einer Zeitüberschreitung beim Warten auf den Alternate Screen.

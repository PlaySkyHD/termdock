# ADR 0001: Core als eigener Prozess, Lebensdauer und Neustart

Status: angenommen (13.11.2026)

## Kontext

Das Konzept verlangt einen zentralen Core, von dem Fenster nur Clients sind (Kapitel 4). „UI schließen, Sessions behalten“ muss Prozesse am Leben halten (Kapitel 6). Mehrere Fenster dürfen keine doppelten Sessions oder Autostarts erzeugen (Abnahme 14).

## Entscheidung

- Der Core ist ein eigener Node-Prozess (`packages/core`, Einstieg `termdock-core`), nicht der Electron-Main-Prozess. In der Desktop-App startet ihn Electron mit `ELECTRON_RUN_AS_NODE=1` als losgelösten Kindprozess (`detached`, eigene Prozessgruppe).
- **Einzelinstanz:** Der Core belegt die Named Pipe `\\.\pipe\termdock-core-<windows-benutzer>`. Scheitert das Belegen, läuft schon ein Core; der neue Prozess beendet sich mit Code `already_running`. Jedes Fenster verbindet sich nur mit dieser Pipe.
- **Startreihenfolge im Core:** Pipe belegen, dann Datenbank öffnen, Backends registrieren und abgleichen (ADR 0005), Autostart-Sessions eintragen, erst dann Anfragen bearbeiten. `hello` wird sofort beantwortet, alle anderen Anfragen warten bis zum Ende des Abgleichs und bis die Autostart-Sessions eingetragen sind (nicht bis zu ihrem Start). Ein zweiter Core scheitert also mit `already_running`, bevor er die Datenbank öffnet. Nicht erreichbare Backends meldet der Core auf stderr und über `core.status`.
- **Abbau:** Bei `core.shutdown`, SIGINT und SIGTERM schließt der Core die Pipe, löst alle PTYs ohne Zustandswechsel, beendet die WSL-Keepalives (tmux-Sessions bleiben) und schließt die Datenbank. Die Signal-Handler gelten ab dem Belegen der Pipe; ein Signal während des Abgleichs bricht ihn ab und baut ebenso ab.
- **Start:** Ein Fenster versucht zuerst zu verbinden. Nur wenn das scheitert, startet es den Core und verbindet sich erneut (begrenzte Wiederholung mit Backoff, 5 s Gesamtzeit).
- **UI schließen, Sessions behalten:** Fenster trennen sich, der Core läuft weiter. WSL-Sessions laufen in tmux, Windows-Sessions als PTY im Core.
- **UI schließen, Sessions beenden:** Der Client sendet `core.shutdown { stopSessions: true }`. Der Core beendet alle verwalteten Sessions kontrolliert (tmux `kill-session`, PTY beenden), schreibt ihren Zustand `Exited` und beendet sich.
- **Core-Neustart oder Absturz:** Beim Start gleicht der Core die gespeicherte Registry mit den Backends ab (Reconcile, ADR 0005). WSL-Sessions, deren tmux-Session noch existiert, werden wieder angebunden. Windows-Sessions überleben das Ende des Core nicht und werden `Interrupted`.

## Folgen

- Windows-Shells haben eine schwächere Persistenzgarantie als WSL: Sie überleben das Schließen der UI, aber nicht das Ende des Core oder einen Windows-Neustart. Die UI zeigt das an (Abnahme 15).
- Der Core braucht keinen Windows-Dienst und keine Adminrechte.

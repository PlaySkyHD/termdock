# Proposal

## Why

Stirbt der Core, während die App offen ist, meldet die Brücke heute nur `coreClosed`. Jedes Pane zeigt „Verbindung zum Core getrennt“ und sendet nichts mehr; erst ein neuer App-Start bringt den Core zurück (#130). Die WSL-Sessions laufen in tmux weiter, der Nutzer kommt aber nicht mehr an sie heran. Nutzerentscheidung vom 19.11.2026: automatisch neu starten, kurzer Hinweis, nach wiederholten Abstürzen aufhören.

## What Changes

- Neuer Zustandsautomat `apps/desktop/src/main/core-supervisor.ts` (`connected` → `restarting` → `connected` | `failed`, dazu `stopped`) mit eingespeister Uhr, Wartefunktion und Verbindungsfunktion. Endet die Verbindung, ruft er erneut `connectOrStartCore` auf (gleiche Backoff-Werte); läuft schon ein anderer Core, verbindet er sich nur.
- Grenze: höchstens 3 Neustarts in 2 Minuten. Danach bleibt der Zustand „getrennt“ mit dem Knopf „Core neu starten“, der den Zähler zurücksetzt.
- Der Supervisor bietet eine stabile `CorePort`, die Abos über Neustarts hinweg auf die neue Verbindung überträgt; Brücke, Layout-Koordinator, Schließen-Ablauf und Screenshot-Modus behalten so ihr Objekt.
- Beim Beenden (Quit-Flow, Ende des Screenshot-Laufs) startet der Supervisor nicht neu.
- Brücke: `coreClosed` trägt `restarting`; neues Event `coreRestarted`; neuer Aufruf `restartCore`. Beim Ende der Verbindung vergisst der Main alle Views (sie starben mit dem Core).
- Renderer: Während des Neustarts zeigt jedes Pane „Core startet neu …“, danach ein kurzer Hinweis „Core neu gestartet“, der sich selbst schließt. Nach `coreRestarted` holt das Fenster Sessions, Workspaces und Core-Status neu, der Store erhöht eine Generation, und jedes Pane hängt seine View neu an; das aktive Pane des Fensters mit dem Fokus übernimmt das Schreibrecht. Eingaben während des Neustarts gehen verloren.
- Screenshot-Gruppe `restart` mit den Szenen `90-core-restarting.png` und `91-core-restarted.png`.
- ADR 0006 um den Neustart ergänzen.

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `desktop-shell`: „Verbinden vor Starten des Core“, „Eingabe übernehmen“ (Szenario zum Ende der Verbindung) und „Screenshot-Modus wählt Szenengruppen“ (MODIFIED); neu „Core nach Absturz neu starten“, „Views nach dem Neustart neu anhängen“, „Screenshot-Szenen des Core-Neustarts“ (ADDED).

## Impact

- Pakete: nur `apps/desktop` (Main: `core-supervisor.ts`, `bridge.ts`, `main.ts`, Screenshot-Szene `screenshot-restart.ts`; Brücke `shared/bridge.ts`, Preload; Renderer: `terminal-controller.ts`, `session-sync.ts`, `ui-store.ts`, `session-display.ts`, `PaneTree.tsx`, `TerminalView.tsx`, `App.tsx`, `StatusBar.tsx`, `styles.css`).
- IPC zum Core: keine neue Methode, keine Versionsänderung. Nach dem Neustart nutzt der Main `hello`, `core.status`, `session.list`, `workspace.list`, `session.attach`, `session.claimWriter` wie beim Start.
- Brücke Renderer ↔ Main: Event `coreClosed { restarting }`, Event `coreRestarted`, Aufruf `restartCore`.
- Datenmodell: unverändert.
- Phase: Betrieb und Robustheit zu Phase 2 (Desktop, Kapitel 12 des Konzepts).
- Non-Goals: Grund des Absturzes im Desktop-Log (folgt mit #129, bis dahin `console.error`); Eingaben während des Neustarts puffern; Windows-Sessions retten (sie werden beim Abgleich `Interrupted`, ADR 0001); einen hängenden, aber lebenden Core erkennen.
- Security: Der Core startet wie bisher als losgelöster Kindprozess mit derselben Pipe des Benutzers (ADR 0002); kein neuer Prozess, keine neue Dependency. `restartCore` nimmt keine Argumente.
- Breaking Changes: keine nach außen. Das Brücken-Event `coreClosed` bekommt ein Pflichtfeld; Preload, Main und Renderer gehören zum selben Paket.

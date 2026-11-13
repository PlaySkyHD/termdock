---
description: 'Review-Methode für TermDock. Nur für Reviews, nicht beim Programmieren laden.'
applyTo: '**'
excludeAgent: ["coding-agent"]
---

# Code-Review

Antworte auf Deutsch. Prüfe zuerst den Diff, dann den betroffenen Code drumherum.

## Was ein Befund ist

- Fehler im Verhalten, Regressionen, Sicherheitslücken, Datenverlust.
- Lifecycle-Fehler: falscher Session-Zustand (z. B. `Running` statt `Interrupted` nach verlorenem Prozess), doppelte Sessions oder Autostarts, verwaiste tmux-Sessions oder PTYs.
- Eingabe-Lock: mehr als eine schreibende View, Eingabe von einer lesenden View, Resize von einer lesenden View.
- Vertragsbrüche zwischen `packages/protocol`, Core und Desktop.
- Shell-Strings mit Nutzereingaben statt Argument-Arrays, IPC ohne Benutzerbeschränkung.
- Unbegrenztes Wachstum: Verlauf über dem Limit, Puffer ohne Obergrenze, Listener ohne Abbau.
- Fehlende Tests für neues Verhalten oder einen Bugfix.
- Verstöße gegen `typescript.instructions.md`, `security.instructions.md`, die ADRs in `docs/adr/` oder `docs/agent-lessons-learned.md`.

Kein Befund: Stil, den Formatter oder Linter schon prüfen; Refactoring-Ideen ohne konkretes Risiko; spekulative Optimierungen.

## Schweregrade

- **Kritisch:** Sicherheit, Datenverlust, falsches Verhalten, Vertragsbruch.
- **Wichtig:** plausibles Risiko für Fehler oder Betrieb, fehlender Test für kritisches Verhalten.
- **Hinweis:** klarer Nutzen, aber nicht nötig für einen sicheren Merge.

## Ausgabe

Befunde nach Schweregrad, je mit Datei und Zeile, konkretem Auslöser („bei Eingabe X passiert Y“) und Richtung für den Fix. Bestätigte Fehler von Vermutungen trennen. Ohne Befund das ausdrücklich sagen.

## OpenSpec

- Ein PR trägt genau einen Change, archiviert mit `openspec archive <change> -y`; unter `openspec/changes/` bleibt nichts außerhalb von `archive/`. Danach muss `openspec validate --specs --strict` grün sein.
- Deltas stehen in der passenden fachlichen Spec. `MODIFIED` ersetzt den alten Text vollständig, `REMOVED` löscht ihn.
- Artefakte sind auf Deutsch. Jede Anforderung hat ein Given/When/Then-Szenario, jede Aufgabe einen prüfenden Test.
- Specs und Code müssen übereinstimmen.

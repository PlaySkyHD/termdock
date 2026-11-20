# Design

## Entscheidungen

- **Migration statt Dokumentation.** Der Orchestrator hat entschieden, den Altbestand zu bereinigen: Eine Klartext-Zeile in `sessions.env` ist ein Leck, das `restart` weiterträgt. Die Migration läuft in der Transaktion der Schema-Version 4 (`Migration.run`, nach `sql`), also ganz oder gar nicht. Sie nutzt dieselbe Regel wie `session.create` (`secretEnvReason`). Ändert sich die Regel später, braucht ein Bestand, der schon auf Version 4 ist, eine neue Migration; eine veröffentlichte wird nicht geändert.
- **Warnung ohne Wert.** Die Migration meldet über einen Rückruf (`onMigrationWarning`, in `run-core.ts` an `logger.warn` gehängt) Session-ID und Schlüssel (auf 64 Zeichen gekürzt, als JSON-String ohne Steuerzeichen). Werte kommen weder in die Meldung noch in einen Fehler.
- **Profile bleiben unberührt.** Profile lehnen Geheimnis-Schlüssel seit Phase 3 ab; nur die neuen Formen (`_KEY`, `_PAT`, `_PASS`, URL mit Passwort) könnten in einem alten Profil stehen. Das Issue nennt nur Sessions, und ein stilles Löschen aus einem Profil, das der Nutzer angelegt hat, wäre überraschender als bei einer Session. Ein solches Profil bleibt lesbar; beim Ändern greift die neue Regel.
- **Heuristik mit Unterstrich.** `_PAT`, `_PASS` und `_KEY` verlangen den Unterstrich, damit `KEYBOARD`, `KEYMAP`, `PATH` und `BYPASS` nicht treffen. `…PUBLIC_KEY` ist ausgenommen. Eine URL gilt als Geheimnis, wenn hinter `scheme://` ein Userinfo mit `:`-Passwort und `@` steht (`[^\s/:@]*:[^\s/@]+@`); `ssh://git@host` und `http://host:8080/x@y` treffen nicht.
- **`runWsl`.** Node setzt `error.message` auf „Command failed: <ganze Kommandozeile>“. Statt dessen meldet `runWsl` Exit-Code, Signal oder den Fehlercode (`ENOENT`). Echte stderr-Ausgabe von `wsl.exe` bleibt wie sie ist. `parseCwdCheck` akzeptiert die neue Zeile `wsl.exe failed: exit code N` als „stumm“.
- **Scanner.** Aliase eines Namespace-Imports folgen wie die der benannten Importe: Destrukturierung (auch `{ spawn: run }`, `{ ["exec"]: run }`), `const run = cp.exec` und `cp["exec"](…)`. Was er nicht verfolgen kann (`cp[name]`, `...rest`, `register(cp.spawn)`), meldet er als `unchecked-use`.

## Risiken

- Ein Schlüssel auf `_KEY` ist manchmal harmlos (`SORT_KEY`). Der Nutzer muss ihn dann umbenennen; die Meldung nennt den Schlüssel. Das ist die bewusste Richtung: lieber ablehnen als speichern.

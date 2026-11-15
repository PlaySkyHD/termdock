# Design

## Kontext

Der Core beantwortet `settings.get|set` und `profile.*` und sendet `settings.changed` und `profile.changed` an alle Listen-Clients (Specs `settings`, `launch-profiles`). Der Desktop-Main nutzt `settings.*` nur im Schließen-Ablauf (`quit-flow.ts`); der Renderer erreicht weder Einstellungen noch Profile. Die Brücke nimmt nur eine feste Liste von Aufrufen an (`shared/bridge.ts`, `main/bridge.ts`). Das WSL-Backend kennt mit `distros()` schon `wsl.exe -l -v` (für die Standard-Distro), aber keine IPC-Methode gibt die Liste heraus. `defaultDistro` und `defaultShell` speichert der Core, nutzt sie aber nicht.

## Entscheidungen

### `wsl.distros` statt Feld in `core.status`

Eine eigene Methode (Protokoll 1.4), weil die Liste nur der Dialog braucht und `core.status` beim Start mit 60 s Timeout läuft; ein langsames `wsl.exe` soll ihn nicht verzögern. Ergebnis `{ distros, defaultDistro?, unavailable? }`: Die Methode scheitert nie an WSL selbst, damit der Dialog ohne Fehlerpfad einen Grund zeigen kann. Grenzen: 64 Namen nach den Regeln für Namen (`isName`), `defaultDistro` muss in der Liste stehen, `unavailable` 1 bis 512 Zeichen. Der Core filtert, was die Grenzen verletzt, statt die ganze Antwort zu verwerfen.

### Aufruf im Core

`CoreServer` bekommt die Option `listDistros` (wie `searchHistory`); `runCore` setzt sie auf `WslBackend.distros({ timeoutMs: 5000 })` des eigenen oder übergebenen WSL-Backends. Ohne WSL-Backend (Tests mit `FakeBackend`) antwortet der Server mit leerer Liste und Grund. `distros()` bleibt der eine Aufruf von `wsl.exe -l -v` (Argument-Array, `WSL_UTF8=1`, `parseDistroList` entfernt Nullbytes); neu ist nur der optionale kürzere Timeout. Die Backend-Schnittstelle (`backend/types.ts`) bleibt unverändert.

### Vorgaben aus den Einstellungen

Eine reine Funktion `launchDefaults(launch, settings)` (`workspace/launch-defaults.ts`) setzt `distro` (nur WSL) bzw. `shell` (nur Windows), wenn sie fehlen. Der Server wendet sie in `session.create` ohne Profil an, `ProfileService.launchFor` für Profil-Sessions (also auch den Autostart). Das Profil selbst bleibt unverändert, damit eine spätere Änderung der Einstellung wirkt. Sessions speichern den aufgelösten `LaunchSpec` wie bisher; Neustarts nutzen ihn.

### Brücke

Neue Aufrufe: `getSettings`, `updateSettings { settings }`, `listProfiles`, `createProfile { profile }`, `updateProfile { profileId, change }`, `deleteProfile { profileId }`, `listDistros`. Der Main prüft Form und Schlüssel (bekannte Schlüssel der Einstellungen, mindestens eine Änderung, nicht leere IDs, Name und `launch` beim Anlegen); die Werte prüft der Core mit seinen Guards. Events: `settingsChanged`, `profilesChanged` an alle Fenster; `openSettings` schickt der Menüeintrag an das fokussierte Fenster (`sendTo`).

### Menü und Kürzel

`Ctrl+,` ist ein Befehl der Keymap (`openSettings`, Taste über `event.code` `Comma`), damit es auch im Terminal greift und die Szene es mit `sendInputEvent` auslösen kann. Der Menüeintrag zeigt das Kürzel mit `registerAccelerator: false`; sonst würde das Menü die Taste vor dem Renderer nehmen und `sendInputEvent` erreicht kein Menü. `Ctrl+,` ist kein `Ctrl+<Buchstabe>` und bleibt damit in der Regel der Keymap.

### Dialog

`SettingsDialog.tsx` mit einer Abschnittsliste links (`role="tablist"`) und dem Inhalt rechts. Zustand lokal im Dialog: beim Öffnen `getSettings`, `listProfiles`, `listDistros`; die Events halten ihn aktuell. Ein offenes Formular behält seine Eingaben (es übernimmt Werte nur beim Öffnen des Abschnitts oder nach dem eigenen Speichern). Modal wie `NameDialog`: `trapFocus`, Escape, Fehler des Core als Text im Dialog. `FOCUSABLE` in `focus-trap.ts` nimmt `select` und `textarea` auf, sonst überspringt Tab diese Felder.

### Formularprüfung als reine Funktionen

`settings-form.ts` ohne DOM: `parseArgumentList` (eine Zeile ein Argument, leere Zeilen fallen weg, keine Teilung an Leerzeichen), `parseEnv` (`NAME=Wert`, gültige und eindeutige Namen), `pathProblem` (WSL: `~` oder `/…`; Windows: Laufwerk oder UNC, wie `projectPathProblem` im Core), `profileFormToParams` (Name, Pfad, Befehl, Umgebung → `ProfileCreateParams` bzw. Änderung), `generalPatch` und `historyPatch` (nur geänderte Schlüssel; leeres Feld → `null`; Limit in MiB → Bytes mit Grenzen). Die Secret-Prüfung der Umgebung bleibt im Core (eine Stelle); der Dialog zeigt dessen Meldung.

### Screenshot-Szene

`screenshot-settings.ts` am Ende des Laufs: öffnet per `Ctrl+,`, nimmt jeden Abschnitt auf, legt ein Profil an (prüft es per `profile.list` im Core), zeigt den Editor, speichert ein Profil mit `API_TOKEN` (Fehler des Core im Dialog), ändert das Verlaufslimit (prüft `settings.get`). Der isolierte Core hat kein eigenes WSL-Verhalten: die Distribution kommt aus dem echten `wsl.exe -l -v`.

## Risiken

- `wsl.exe -l -v` kann bei einem hängenden WSL-Dienst lange brauchen: 5 s Timeout im Core, der Main wartet 10 s.
- Distributionsnamen mit Nicht-ASCII-Zeichen aus einer UTF-16-Ausgabe ohne `WSL_UTF8` würden falsch dekodiert; aktuelle WSL-Versionen beachten `WSL_UTF8`.

## Abhängigkeiten

Keine neuen Dependencies.

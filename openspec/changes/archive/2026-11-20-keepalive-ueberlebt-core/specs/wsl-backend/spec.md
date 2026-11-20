## MODIFIED Requirements

### Requirement: Keepalive je Distro

Solange das Backend mindestens eine Session einer Distro kennt (gestartet, angehängt oder per `exists` gefunden), SHALL je Distro ein Prozess `wsl.exe -d <distro> --cd ~ --exec tmux -L <socket> wait-for termdock-keepalive` ohne PTY laufen, losgelöst vom Core (`detached`), so dass er dessen Ende überlebt. Endet die letzte bekannte Session der Distro (`kill`, Programm-Ende oder `exists` meldet sie als weg), MUST das Backend den Prozess beenden.

#### Scenario: Session überlebt eine Pause ohne PTY

- **GIVEN** eine Session, deren PTY mit `dispose()` geschlossen wurde
- **WHEN** 25 s lang kein anderer `wsl.exe`-Aufruf läuft
- **THEN** liefert `exists` danach `true`

#### Scenario: Letzte Session endet

- **GIVEN** zwei bekannte Sessions in derselben Distro
- **WHEN** beide beendet werden
- **THEN** läuft der Keepalive nach der ersten weiter und ist nach der zweiten beendet

#### Scenario: Core wird hart beendet

- **GIVEN** ein Core mit einer laufenden WSL-Session und ihrem Keepalive
- **WHEN** der Core-Prozess ohne `core.shutdown` beendet wird (Update, Task-Manager) und 30 s vergehen
- **THEN** läuft derselbe Keepalive-Prozess weiter und die tmux-Session existiert

#### Scenario: Verwaister Keepalive endet mit dem tmux-Server

- **GIVEN** ein Keepalive, dessen Core beendet ist
- **WHEN** die letzte tmux-Session seines Sockets endet
- **THEN** endet auch der Keepalive samt seinem `wsl.exe`

### Requirement: Keepalive-Neustart und Abbau

Endet ein Keepalive unerwartet, während noch Sessions seiner Distro bekannt sind, SHALL das Backend ihn neu starten, mit exponentiell wachsender Wartezeit (1 s, 2 s, … höchstens 60 s), die nach einer Laufzeit von mehr als 30 s zurückgesetzt wird. Lässt sich der Zustand einer Session nach dem Ende ihres tmux-Clients nicht feststellen, MUST das Backend sie im Keepalive freigeben. Nach dem Schließen des Backends MUST jeder laufende Keepalive weiterlaufen und keiner mehr starten.

#### Scenario: Keepalive stirbt

- **GIVEN** eine bekannte Session und ihr Keepalive
- **WHEN** der Keepalive-Prozess unerwartet endet
- **THEN** startet kurz danach ein neuer

#### Scenario: Keepalive scheitert wiederholt

- **GIVEN** ein Keepalive, der sofort nach dem Start endet
- **WHEN** er mehrfach hintereinander neu gestartet wird
- **THEN** verdoppelt sich die Wartezeit bis höchstens 60 s statt dauernd neu zu starten

#### Scenario: Backend schließen

- **GIVEN** laufende Keepalives
- **WHEN** das Backend geschlossen wird
- **THEN** laufen sie weiter, und weder ein Neustart noch eine neue Session startet danach einen Keepalive

## ADDED Requirements

### Requirement: Übernahme verbliebener Keepalives

Bevor ein Backend den ersten Keepalive einer Distro startet, SHALL es die Keepalives seines Sockets in dieser Distro beenden, die ein früherer Core hinterlassen hat (`wsl.exe -d <distro> --cd ~ --exec pkill -x -f "tmux -L <socket> wait-for termdock-keepalive"`, Argument-Array), und erst danach seinen eigenen starten. Scheitert das Beenden, MUST es trotzdem starten. Es SHALL das je Distro nur einmal tun und dabei nie einen eigenen Keepalive treffen.

#### Scenario: Neuer Core nach einem Kill

- **GIVEN** der Keepalive eines hart beendeten Core und dessen tmux-Session
- **WHEN** ein neuer Core startet und die Session beim Abgleich findet
- **THEN** ist der alte Keepalive beendet und genau einer läuft, der des neuen Core

#### Scenario: Kein Leck nach mehreren Neustarts

- **GIVEN** eine WSL-Session
- **WHEN** der Core dreimal nacheinander hart beendet und neu gestartet wird
- **THEN** läuft für ihren Socket genau ein Keepalive

#### Scenario: Übernahme scheitert

- **GIVEN** eine Distro, in der der `pkill`-Aufruf fehlschlägt
- **WHEN** das Backend die erste Session der Distro hält
- **THEN** startet es seinen Keepalive trotzdem

#### Scenario: Session während der Übernahme erneut gehalten

- **GIVEN** eine laufende Übernahme, während der die einzige Session freigegeben und wieder gehalten wird
- **WHEN** die Übernahme endet
- **THEN** startet genau ein Keepalive, und es folgt keine zweite Übernahme

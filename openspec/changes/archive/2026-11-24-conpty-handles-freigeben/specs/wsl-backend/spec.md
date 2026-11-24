## ADDED Requirements

### Requirement: Handles nach dem Ende einer PTY

Meldet der Core das Ende einer PTY, SHALL er zuvor ihre Eingabe-Pipe schließen, auch nach einem natürlichen Ende. Schließt er eine PTY nach einem Verlust, MUST er auch ihre Verbindung im Leser schließen. 20 PTYs, die von selbst enden, MUST den Core um weniger als 50 Handles wachsen lassen. Das HPCON bleibt bis zum Ende des Core (ADR 0008).

#### Scenario: Natürliches Ende

- **GIVEN** ein Core, der eine PTY mit `cmd.exe` schon einmal gestartet hat
- **WHEN** nacheinander 20 PTYs mit `cmd /c echo x` laufen und von selbst enden
- **THEN** wächst die Zahl der Handles des Prozesses um weniger als 50, und der Leser hält keine Pipe mehr

#### Scenario: Gescheiterte Weiterleitung

- **GIVEN** zwei PTYs, bei einer scheitert die Verbindung zur Weiterleitung, und ihr Client hält seine Seite offen
- **WHEN** der Core sie schließt
- **THEN** hält der Leser nur noch die Pipe der anderen PTY

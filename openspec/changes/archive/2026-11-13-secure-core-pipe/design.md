# Design

## Context

ADR 0002 verlangt eine Pipe „nur für den aktuellen Benutzer“. `CoreServer` nutzt `net.createServer().listen(pipePath)`; libuv erzeugt die Pipe mit `CreateNamedPipeW(..., lpSecurityAttributes = NULL)`. Issue #14 vermutet, dass der Standard-Deskriptor Fremden Lesezugriff gibt. Das wurde gemessen, nicht angenommen.

## Messung: Sicherheitsdeskriptor einer Node-Pipe (Windows 11 Pro 10.0.26200, Node 25.2.1)

Messweg: Node-Skript erzeugt per `net.createServer().listen("\\\\.\\pipe\\...")` eine Pipe. `Get-Acl` und `FileStream.GetAccessControl` scheitern bei Pipes mit Fehler 87. Funktioniert hat: `CreateFile(path, READ_CONTROL)` (kein Datenzugriff, verbraucht keine Verbindung), dann `GetSecurityInfo(SE_KERNEL_OBJECT, OWNER|GROUP|DACL)` und `ConvertSecurityDescriptorToStringSecurityDescriptor`. Der Test `pipe-acl.test.ts` benutzt denselben Weg.

```
O:<Benutzer-SID>G:<Benutzer-SID>D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;<Benutzer-SID>)(A;;FR;;;WD)(A;;FR;;;AN)
```

| Trustee                                    | Maske      | Bedeutung                                         |
| ------------------------------------------ | ---------- | ------------------------------------------------- |
| SYSTEM (`SY`)                              | `0x1F01FF` | Vollzugriff                                       |
| Administratoren (`BA`)                     | `0x1F01FF` | Vollzugriff                                       |
| aktueller Benutzer (Besitzer)              | `0x1F01FF` | Vollzugriff                                       |
| Everyone (`WD`, S-1-1-0)                   | `0x120089` | `FILE_GENERIC_READ` (kein `FILE_WRITE_DATA 0x2`)  |
| Anonymous (`AN`, S-1-5-7)                  | `0x120089` | wie Everyone                                      |

Das entspricht der Dokumentation des Named Pipe Filesystems (Standard-DACL: Vollzugriff für SYSTEM, Administratoren und Ersteller, Lesezugriff für Everyone und Anonymous). Die Pipe ist also nicht „nur für den Benutzer“, aber auch nicht beschreibbar:

- Ein fremdes Konto kann die Pipe nur mit reinem Lesezugriff öffnen. Node und der Client des Core öffnen mit Lese- und Schreibrecht und bekommen `ACCESS_DENIED`.
- Ein lesend verbundener Fremder kann keine Anfrage senden. Der Core sendet nur an Verbindungen mit View oder `session.list`-Abo, beides entsteht durch Anfragen. Es fließen also keine Events und keine Nutzdaten.
- Rest: Ein Fremder kann Verbindungen offen halten (Ressourcen) und sieht, dass die Pipe existiert. Administratoren haben Vollzugriff; das ist nicht zu ändern und kein Gewinn an Schutz, da ein Administrator ohnehin auf Prozessspeicher zugreifen kann.

Nicht getestet: ein zweites lokales Konto (es werden keine Benutzer angelegt) und ein erhöht gestarteter Core (dann kann sich Besitzer und Benutzer-ACE ändern). Die Aussagen über Fremde folgen aus den Masken; der manuelle Prüfschritt steht im Bericht.

## Goals / Non-Goals

**Goals:**

- Den tatsächlichen Schutz belegen und per Windows-Test festhalten; Spec und ADR 0002 so formulieren, wie es gilt.
- Offene Verbindungen ohne Handshake begrenzen.

**Non-Goals:**

- Eine DACL, die auch Lesezugriff für Everyone/Anonymous entfernt (siehe unten), Authentifizierung im Protokoll (`packages/protocol` bleibt unverändert).

## Decisions

### Variante (a), Client-Identität prüfen: nicht möglich ohne Native-Code

`GetNamedPipeClientProcessId` und eine Token-Abfrage sind Win32-Aufrufe. Node bietet weder einen Zugriff auf den Handle der Verbindung noch die Client-PID (`net.Socket` für Pipes hat keine solche Eigenschaft). Ohne Native-Addon oder FFI ist die Variante nicht umsetzbar.

### Variante (b), eigene DACL: nicht möglich ohne Native-Code

Geprüft wurde, was Node schon kann: `listen({ readableAll, writableAll })` ruft `uv_pipe_chmod`. Gemessen: `readableAll` setzt die Everyone-Maske auf `0x120189`, `writableAll` auf `0x120196`, beides auf `0x12019F`; Everyone wird also nie entfernt, nur erweitert oder ersetzt, und ohne die Optionen bleibt der Standard (erste Messung). Eine Option, die Everyone entfernt, gibt es nicht. `CreateNamedPipe` mit `SECURITY_ATTRIBUTES` bräuchte ein Native-Addon (neue Dependency mit Build-Kette; Lessons Learned: Bau aus dem Quelltext scheitert auf diesem Host, node-pty liefert nur seine eigenen Prebuilds). Der Aufwand steht in keinem Verhältnis zum Restrisiko.

### Variante (c) mit Einschränkung: Standard-Deskriptor belegen

Der Standard-Deskriptor gibt Fremden keinen Schreibzugriff (Messung oben); damit ist das Ziel „nur der aktuelle Benutzer kann den Core bedienen“ erreicht, das Ziel „nur der aktuelle Benutzer kann die Pipe öffnen“ nicht. Das Restrisiko (lesendes Öffnen, Verbindungen belegen) ist klein. Entscheidung: kein Native-Code. Der Windows-Test prüft die DACL der echten Pipe und schlägt an, falls Node oder Windows künftig einem fremden Trustee Schreibrecht geben oder einen zusätzlichen Trustee einführen. Folge-Option, falls das Restrisiko nicht reicht: kleines Native-Modul mit `CreateNamedPipe` und expliziter DACL (Benutzer-SID und SYSTEM) als eigener Change.

### Hello-Frist

`hello` muss innerhalb von 5 s abgeschlossen sein, sonst `socket.destroy()` ohne Antwort. 5 s sind großzügig gegenüber einem lokalen Client (Millisekunden) und kurz genug, dass lesend verbundene Fremde oder hängende Clients keine Verbindungen dauerhaft belegen. Der Timer läuft je Verbindung (`helloTimer`), endet beim erfolgreichen `hello` und in `onClose`. Konfigurierbar über `helloTimeoutMs`, damit Tests ohne Wartezeit auskommen. Es gibt kein „aus“: Ein Wert, der keine positive endliche Zahl ist (0, negativ, NaN, Infinity), lässt den Start mit `RangeError` scheitern, damit ein Konfigurationsfehler den Schutz nicht still abschaltet.

### Grenze für Verbindungen ohne hello

Die Frist begrenzt nur die Dauer, nicht die Zahl. `maxPendingHandshakes` (Standard 32, ganzzahlig ≥ 1, sonst `RangeError`) begrenzt die gleichzeitigen Verbindungen ohne abgeschlossenes `hello`; weitere werden sofort zerstört. Ein Zähler wird bei Annahme erhöht und bei `hello` oder Schließen gesenkt. 32 liegt weit über dem Bedarf eines lokalen Benutzers (Fenster plus wenige Hilfsclients) und begrenzt die Last eines lesend verbundenen Fremden.

### SDDL-Auswertung als reine Logik

`parseDacl`, `foreignAllowEntries`, `grantsWrite` arbeiten auf SDDL-Text und sind ohne Windows testbar. Alles, was der Parser nicht sicher beurteilen kann, wirft einen Fehler, damit der Test nichts stillschweigend überspringt: unbekannte Rechtecodes (bekannt sind generische, Standard-, Verzeichnisdienst-, Datei-, Registry- und Label-Codes sowie Hex-Masken), Text außerhalb der ACEs, andere ACE-Typen als Allow/Deny (Objekt- und Callback-ACEs) und eine fehlende oder NULL-DACL (`NO_ACCESS_CONTROL`, Vollzugriff für alle). Eine leere DACL (`D:`) ist gültig. DACL-Flags (`P`, `AI`, `AR`) vor den ACEs sind erlaubt. Als Schreibrecht gelten `FILE_WRITE_DATA`, `FILE_APPEND_DATA`, `WRITE_DAC`, `WRITE_OWNER`, `GENERIC_WRITE` und `GENERIC_ALL`. Nicht fremd sind der eigene SID, SYSTEM, Administratoren und Creator Owner.

## Risks / Trade-offs

- [Fremdes Konto öffnet die Pipe lesend] → keine Daten, keine Anfragen möglich; Hello-Frist begrenzt die Dauer; Test hält die Rechte fest.
- [Windows-Standard ändert sich] → Windows-Test in der CI (`windows-latest`) schlägt an.
- [Core läuft erhöht] → nicht getestet; der Test prüft nur den Fall des normalen Benutzers.

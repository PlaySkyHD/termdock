# Design

## Kontext

Der feste Socket `termdock-test` ist gemeinsamer Zustand zwischen parallelen Läufen. Screenshot-Läufe lösen das Problem schon mit `termdock-test-<pid>-<nonce>` und räumen verwaiste Server beendeter Prozesse beim Start auf (`cleanStaleSockets`).

## Entscheidungen

- **Ein Socket je Testdatei, nicht je Vitest-Lauf.** Jede Datei lädt ihre Module neu; ein Modul-Level-Wert gilt je Datei. Das genügt für die Isolation zwischen Läufen und Dateien und braucht keinen Umgebungsvariablen-Austausch zwischen Workern.
- **Namensform der Screenshot-Läufe.** Der Name `termdock-test-<pid>-<nonce>` passt zur bestehenden Aufräumlogik der Desktop-App; ein abgebrochener Testlauf wird so auch vom nächsten Screenshot-Lauf aufgeräumt. Die Logik wird im Core-Test-Helfer nicht aus der Desktop-App importiert (Abhängigkeitsrichtung), sondern knapp nachgebaut.
- **`kill-server` nur auf Lauf-Sockets.** `killWslTestServer` lehnt jeden Namen ab, der nicht der Form entspricht, damit `termdock` und `termdock-test` nie getroffen werden. Aufräumen verwaister Server nimmt nur Sockets beendeter Prozesse; der eigene und die lebender Prozesse bleiben.
- **Dateien laufen weiter nacheinander** (`fileParallelism: false`), um die Last auf WSL klein zu halten; die Isolation hängt nicht mehr daran.
- **`keepalive.wsl.test.ts` (PR #140)** nutzt einen eigenen Namen `termdock-test-keepalive-<nonce>`; der Helfer lässt solche Namen unberührt und kann dort später übernommen werden.

## Risiken

- Wird ein Lauf hart abgebrochen, bleibt der Server bis zum nächsten Lauf oder Screenshot-Lauf bestehen (er beendet sich selbst, sobald keine Session mehr läuft).

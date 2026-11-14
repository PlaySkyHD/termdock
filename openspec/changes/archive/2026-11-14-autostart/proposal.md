# Proposal

## Why

Startprofile tragen seit #58 das Feld `autostart`, der Core speichert es aber nur. Konzept Kap. 6 und die Abnahmen 07 und 14 verlangen, dass nur ausdrücklich markierte Profile automatisch starten, ohne Doppelstarts bei mehreren Fenstern und Core-Neustarts (Issue #61, Phase 3).

## What Changes

- Neues Core-Modul `packages/core/src/session/autostart.ts`. Nach dem Reconcile beim Core-Start legt der Core für jedes Profil mit `autostart: true`, das keine Session in `Starting`, `Running` oder `Detached` hat (Bindung über `profileId`), eine neue Session an. Name, Workspace, Verlauf-Schalter und `LaunchSpec` (samt Standardverzeichnis) kommen aus dem Profil, über dieselbe Logik wie `session.create` mit `profileId`.
- Der Autostart läuft nur im Core und genau einmal je Core-Start (`run-core.ts`). Clients lösen ihn nie aus.
- Anfragen außer `hello` warten zusätzlich, bis die Autostart-Sessions eingetragen sind (nicht bis zu ihrem Start). Jeder Client sieht sie damit schon in seiner ersten `session.list`.
- Eine Session in `Exited`, `Interrupted` oder `Archived` verhindert keinen Autostart; die alte Session bleibt unverändert.
- Ist das Backend eines Autostart-Profils nicht erreichbar, meldet der Core das einmal auf stderr und über `core.status` (`backendUnavailable`) und legt für diese Profile keine Session an. Scheitert ein Start, wird die Session `Interrupted` und der Fehler einmal gemeldet. Es gibt keine Wiederholung.
- Neue Sessions laufen über `SessionRegistry.create` und werden damit wie jede neue Session mit `session.created` gemeldet.
- ADR 0001 (Startreihenfolge) und ADR 0005 (Autostart) werden präzisiert.

Phase: 3 (Konzept Kap. 12, „Startprofile, Autostart-Regeln“).

## Capabilities

### New Capabilities

(keine)

### Modified Capabilities

- `launch-profiles`: „Profile verwalten“ (`autostart` wird nicht mehr nur gespeichert); neue Anforderungen „Autostart beim Core-Start“ und „Autostart bei nicht erreichbarem Backend“.
- `session-persistence`: „Reconcile beim Core-Start“ (Autostart erst nach dem Reconcile, Neustart ohne Doppelstart).
- `core-ipc`: „Startreihenfolge des Core“ (Anfragen warten auf das Eintragen der Autostart-Sessions) und „Status des Core“ (Backends, die der Autostart nicht erreicht).

## Impact

- `packages/core`: neu `session/autostart.ts` mit Tests; `bin/run-core.ts` ruft den Autostart auf; `session/registry.ts` bekommt eine Methode am Klassenende, mit der der Autostart ein nicht erreichbares Backend für `core.status` meldet. Neuer WSL-Integrationstest mit Core-Neustart.
- IPC-Methoden und Datenmodell bleiben unverändert (`packages/protocol` wird nicht geändert). Keine neue Migration: `sessions.profile_id` und der Index `sessions_profile` bestehen seit #58.
- Dependencies: keine neuen.
- Non-Goals: Autostart beim Ändern eines Profils zur Laufzeit, Wiederholung nach einem gescheiterten Start, Autostart über eine Client-Anfrage, UI für Autostart (`apps/desktop`).
- Security: Der Befehl bleibt ein Argument-Array aus dem gespeicherten Profil; Logs nennen Profil-IDs, keine Befehle oder Umgebungswerte.
- Breaking Changes: keine. Clients sehen zusätzliche Sessions, die sie wie jede andere über `session.list`, `session.created` und `session.stateChanged` kennen.

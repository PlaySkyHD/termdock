# Design

- Die Prüfung teilt sich in eine reine Funktion `isRectVisible(element, container, viewport)` (Unit-Tests) und ein Seitenskript, das Element, nächsten Vorfahren mit `overflow` auto oder scroll und Fenstergröße liefert. Ohne scrollbaren Vorfahren zählt nur das Fenster.
- Eine Toleranz von 0,5 px fängt Rundung im Layout ab.
- `captureWindow(win, dir, name, options)` in `screenshot-page.ts` ersetzt die vier Kopien. Die Bildnamen bleiben unverändert.
- Keine neuen Abhängigkeiten.

// The bar of layout patterns at the top of the tab area (#78, Snap Layouts as in Windows 11). It opens while a tab or a
// pane rests at the top edge of the tab area and shows every pattern that has room for the views: each field is
// a drop target with the name and the state dot of the view that would land there, the dragged one marked, empty
// fields marked as such. The fields stay mounted (hidden) all the time, because the valid targets of a drag are
// collected when it starts (`drag-model.ts`). The rules are `snap-layouts.ts`; the drop goes through `applyMove`.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { LayoutWindow, SessionInfo } from "@termdock/protocol";
import { DROP_TARGET_ATTRIBUTE, useDrag } from "./drag/DragProvider.js";
import { parseZoneTarget } from "./drag/drop-zones.js";
import { dropSource, snapTarget } from "./layout-drop.js";
import {
  patternRects,
  SNAP_DWELL_MS,
  SNAP_PATTERNS,
  snapBarStep,
  snapFields,
  visiblePatterns,
} from "./snap-layouts.js";
import type { SnapField } from "./snap-layouts.js";
import { StateIcon } from "./StateIcon.js";

export interface SnapBarProps {
  window: LayoutWindow;
  sessions: readonly SessionInfo[];
  /** The tab area: the bar opens at its top edge. */
  area: RefObject<HTMLElement | null>;
}

export function SnapBar({ window, sessions, area }: SnapBarProps) {
  const drag = useDrag();
  const bar = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const dwell = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { state } = drag;
  const dragging = state.phase === "dragging" ? state : undefined;
  const payload = dragging?.payload;
  const source = useMemo(() => (payload ? dropSource(payload) : undefined), [payload]);
  // The same rule as the drop (`applySnap`): a pattern shows when one of its fields changes something.
  const shown = useMemo(() => (source ? visiblePatterns(window, source) : []), [window, source]);
  const valid = new Set(dragging?.valid.filter((id) => id.startsWith("snap:")) ?? []);
  const x = dragging?.x;
  const y = dragging?.y;
  const canOpen = shown.length > 0;

  // Opens and closes after the pointer, outside of render: the boxes are read once the page is laid out.
  useLayoutEffect(() => {
    const stopDwell = (): void => {
      clearTimeout(dwell.current);
      dwell.current = undefined;
    };
    const areaBox = area.current?.getBoundingClientRect();
    if (x === undefined || y === undefined || !canOpen || !areaBox) {
      stopDwell();
      setOpen(false);
      return;
    }
    const step = snapBarStep(
      { x, y },
      areaBox,
      open ? bar.current?.getBoundingClientRect() : undefined,
      open,
    );
    if (step === "dwell") {
      dwell.current ??= setTimeout(() => {
        dwell.current = undefined;
        setOpen(true);
      }, SNAP_DWELL_MS);
      return;
    }
    stopDwell();
    setOpen(step === "open");
  }, [x, y, canOpen, open, area]);
  useEffect(() => () => clearTimeout(dwell.current), []);

  const over = dragging?.over !== undefined ? parseZoneTarget(dragging.over) : undefined;

  return (
    <div
      ref={bar}
      className={`snap-bar${open ? " snap-bar--open" : ""}`}
      data-snap-bar={open ? "open" : "closed"}
      role="group"
      aria-label="Layout-Vorschläge"
    >
      {SNAP_PATTERNS.map(({ id, label, slots }) => {
        const visible = shown.includes(id);
        // The fields as they would be filled: for the field under the pointer, otherwise with the dragged view first.
        const overSlot = over?.base === `snap:${id}` ? Number(over.zone) : 0;
        const fields: ReadonlyArray<SnapField | undefined> =
          (source && visible && snapFields(window, source, id, overSlot)) || Array.from({ length: slots });
        const rects = patternRects(id);
        return (
          <div
            key={id}
            className={`snap-pattern${visible ? "" : " snap-pattern--hidden"}`}
            data-snap-pattern={id}
            aria-label={label}
          >
            <div className="snap-pattern__fields">
              {rects.map((rect, slot) => {
                const target = snapTarget(id, slot);
                const field = fields[slot];
                const session = field?.pane && sessions.find((each) => each.id === field.pane!.sessionId);
                const name = field?.pane ? (session?.name ?? "Unbekannte Session") : "leer";
                const isOver = dragging?.over === target;
                return (
                  <div
                    key={slot}
                    className={[
                      "snap-field",
                      field?.pane ? "" : "snap-field--empty",
                      field?.moved ? "snap-field--moved" : "",
                      isOver ? "snap-field--over" : "",
                      valid.has(target) ? "" : "snap-field--blocked",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{
                      left: `${rect.x * 100}%`,
                      top: `${rect.y * 100}%`,
                      width: `${rect.width * 100}%`,
                      height: `${rect.height * 100}%`,
                    }}
                    data-snap-field={slot}
                    data-snap-session={field?.pane?.sessionId}
                    data-snap-moved={field?.moved ? "true" : undefined}
                    title={`${label}, Feld ${slot + 1}: ${
                      field?.pane
                        ? name
                        : "leer, wird nicht angelegt; die anderen Felder teilen sich den Platz"
                    }`}
                    {...{ [DROP_TARGET_ATTRIBUTE]: target }}
                  >
                    {session && <StateIcon session={session} />}
                    <span className="snap-field__name">{name}</span>
                  </div>
                );
              })}
            </div>
            <span className="snap-pattern__label">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

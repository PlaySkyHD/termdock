// Drag and drop by pointer events, the React part (#63, #67): one provider per window around sidebar, tab bar and
// panes. Sources call `sourceProps(payload)` for their `onPointerDown`; targets carry `data-drop-target="<id>"` and
// take their look from `targetClass` or `zonesOf`. An element with `data-drop-zones="pane"` or `"sides"` stands for
// one target per zone (`drop-zones.ts`). Each area registers its rules with `useDropHandler`; a target belongs to
// the first handler that accepts it. The provider owns the controller, the ghost and the page state while dragging.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { DragController } from "./drag-controller.js";
import { dropHighlight, IDLE } from "./drag-model.js";
import type { DragPayload, DragState } from "./drag-model.js";
import { parseZoneTarget, pickZoneTarget, ZONE_SETS, zoneTargets } from "./drop-zones.js";
import type { ZoneSet } from "./drop-zones.js";

export const DROP_TARGET_ATTRIBUTE = "data-drop-target";
export const DROP_ZONES_ATTRIBUTE = "data-drop-zones";

/** The rules of one area: whether it takes the payload on the target, and what a drop there does. */
export interface DropHandler {
  /** Pure: the same rule the context menu uses. */
  accepts(payload: DragPayload, targetId: string): boolean;
  onDrop(payload: DragPayload, targetId: string): void;
}

export interface DragApi {
  state: DragState;
  /** Props for a source element: its `pointerdown` starts a press. */
  sourceProps(payload: DragPayload): { onPointerDown: (event: ReactPointerEvent) => void };
  /** Class names for a drop target: `drop-target`, plus `--valid` and `--over` while dragging. */
  targetClass(targetId: string): string;
  /** The valid zones of an element with zones while dragging, and the one under the pointer. */
  zonesOf(base: string): { valid: string[]; over: string | undefined };
  /** Registers the rules of an area; the returned function removes them. */
  register(handler: DropHandler): () => void;
}

const DragContext = createContext<DragApi | undefined>(undefined);

export function useDrag(): DragApi {
  const api = useContext(DragContext);
  if (!api) throw new Error("useDrag needs a DragProvider");
  return api;
}

/** Registers the rules of an area for as long as it is mounted; reads the latest `handler` on every call. */
export function useDropHandler(handler: DropHandler): void {
  const { register } = useDrag();
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(
    () =>
      register({
        accepts: (payload, targetId) => latest.current.accepts(payload, targetId),
        onDrop: (payload, targetId) => latest.current.onDrop(payload, targetId),
      }),
    [register],
  );
}

function zoneSetOf(element: Element): ZoneSet | undefined {
  const set = element.getAttribute(DROP_ZONES_ATTRIBUTE);
  return set !== null && set in ZONE_SETS ? (set as ZoneSet) : undefined;
}

/** Id of the drop target at the point (with its zone), or undefined. */
function targetAt(x: number, y: number, valid: (targetId: string) => boolean): string | undefined {
  const element = document.elementFromPoint(x, y)?.closest(`[${DROP_TARGET_ATTRIBUTE}]`);
  const base = element?.getAttribute(DROP_TARGET_ATTRIBUTE);
  if (!element || !base) return undefined;
  const set = zoneSetOf(element);
  if (!set) return base;
  const box = element.getBoundingClientRect();
  return pickZoneTarget(set, base, box, x, y, valid);
}

function allTargets(): string[] {
  return [...document.querySelectorAll(`[${DROP_TARGET_ATTRIBUTE}]`)].flatMap((element) => {
    const base = element.getAttribute(DROP_TARGET_ATTRIBUTE) ?? "";
    const set = zoneSetOf(element);
    return set ? zoneTargets(base, set) : [base];
  });
}

export function DragProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DragState>(IDLE);
  const handlers = useRef(new Set<DropHandler>());

  const controller = useMemo(() => {
    const handlerFor = (payload: DragPayload, targetId: string): DropHandler | undefined =>
      [...handlers.current].find((handler) => handler.accepts(payload, targetId));
    const created: DragController = new DragController({
      host: window,
      hit: (x, y) => {
        const current = created.getState();
        const payload =
          current.phase === "pressed" || current.phase === "dragging" ? current.payload : undefined;
        return targetAt(x, y, (id) => payload !== undefined && handlerFor(payload, id) !== undefined);
      },
      targets: allTargets,
      accepts: (payload, targetId) => handlerFor(payload, targetId) !== undefined,
      onChange: setState,
      onDrop: (payload, targetId) => handlerFor(payload, targetId)?.onDrop(payload, targetId),
      setDragging: (active) => document.body.classList.toggle("is-dragging", active),
    });
    return created;
  }, []);
  useEffect(() => () => controller.dispose(), [controller]);

  const register = useMemo(
    () =>
      (handler: DropHandler): (() => void) => {
        handlers.current.add(handler);
        return () => void handlers.current.delete(handler);
      },
    [],
  );

  const api = useMemo<DragApi>(
    () => ({
      state,
      register,
      sourceProps: (payload) => ({
        onPointerDown: (event) => controller.press(payload, event),
      }),
      targetClass: (targetId) => {
        const highlight = dropHighlight(state, targetId);
        return `drop-target${highlight === "none" ? "" : ` drop-target--valid${highlight === "over" ? " drop-target--over" : ""}`}`;
      },
      zonesOf: (base) => {
        if (state.phase !== "dragging") return { valid: [], over: undefined };
        const zoneOf = (id: string): string | undefined => {
          const parsed = parseZoneTarget(id);
          return parsed?.base === base ? parsed.zone : undefined;
        };
        return {
          valid: state.valid.flatMap((id) => zoneOf(id) ?? []),
          over: state.over === undefined ? undefined : zoneOf(state.over),
        };
      },
    }),
    [state, controller, register],
  );

  return (
    <DragContext.Provider value={api}>
      {children}
      {state.phase === "dragging" && (
        <div className="drag-ghost" style={{ left: state.x + 14, top: state.y + 14 }} data-drag-ghost="">
          {state.payload.label ?? state.payload.id}
        </div>
      )}
    </DragContext.Provider>
  );
}

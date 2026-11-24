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

/**
 * A drag that leaves the window (#68): which payloads may, and what the main process hears while the pointer is
 * outside (`hover`), when it comes back or the drag ends (`end`) and at a release outside (`drop`).
 */
export interface OutsideRules {
  leaves(payload: DragPayload): boolean;
  hover(payload: DragPayload, x: number, y: number): void;
  end(): void;
  drop(payload: DragPayload, x: number, y: number): void;
}

/** A drag of another window over this one, as the main process reports it (#68). */
export interface ExternalDrag {
  /** The pointer is at the point; shows the valid targets and the one under it like a drag of this window. */
  hover(payload: DragPayload, x: number, y: number): void;
  leave(): void;
  /** The valid target at the point for the payload, judged now; undefined over none. */
  targetAt(payload: DragPayload, x: number, y: number): string | undefined;
}

export interface DragApi {
  state: DragState;
  external: ExternalDrag;
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

export function DragProvider({ children, outside }: { children: ReactNode; outside?: OutsideRules }) {
  const [local, setLocal] = useState<DragState>(IDLE);
  // A drag of another window over this one (#68); a drag of this window wins.
  const [external, setExternal] = useState<DragState>(IDLE);
  const state = local.phase === "idle" ? external : local;
  const handlers = useRef(new Set<DropHandler>());
  const outsideRules = useRef(outside);
  outsideRules.current = outside;
  /** The main process shows this window's drag elsewhere right now. */
  const hoveringOutside = useRef(false);
  /** The valid targets of the external drag, collected once when it enters (like a drag of this window). */
  const externalValid = useRef<readonly string[] | undefined>(undefined);
  const handlerFor = useMemo(
    () =>
      (payload: DragPayload, targetId: string): DropHandler | undefined =>
        [...handlers.current].find((handler) => handler.accepts(payload, targetId)),
    [],
  );

  const controller = useMemo(() => {
    const onChange = (next: DragState): void => {
      setLocal(next);
      const rules = outsideRules.current;
      if (next.phase === "dragging" && next.outside === true && rules?.leaves(next.payload) === true) {
        hoveringOutside.current = true;
        rules.hover(next.payload, next.x, next.y);
      } else if (hoveringOutside.current) {
        hoveringOutside.current = false;
        rules?.end();
      }
    };
    const created: DragController = new DragController({
      host: window,
      hit: (x, y) => {
        const current = created.getState();
        // While dragging, the valid targets are known since the start; only the first move asks the rules.
        if (current.phase === "dragging") return targetAt(x, y, (id) => current.valid.includes(id));
        const payload = current.phase === "pressed" ? current.payload : undefined;
        return targetAt(x, y, (id) => payload !== undefined && handlerFor(payload, id) !== undefined);
      },
      targets: allTargets,
      accepts: (payload, targetId) => handlerFor(payload, targetId) !== undefined,
      leaves: (payload) => outsideRules.current?.leaves(payload) === true,
      outside: (x, y) => x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight,
      onChange,
      onDrop: (payload, targetId) => handlerFor(payload, targetId)?.onDrop(payload, targetId),
      onOutside: (payload, x, y) => outsideRules.current?.drop(payload, x, y),
      setDragging: (active) => document.body.classList.toggle("is-dragging", active),
    });
    return created;
  }, [handlerFor]);

  const externalDrag = useMemo<ExternalDrag>(
    () => ({
      hover: (payload, x, y) => {
        const valid = (externalValid.current ??= allTargets().filter(
          (id) => handlerFor(payload, id) !== undefined,
        ));
        const over = targetAt(x, y, (id) => valid.includes(id));
        setExternal({
          phase: "dragging",
          payload,
          x,
          y,
          valid,
          over: over !== undefined && valid.includes(over) ? over : undefined,
        });
      },
      leave: () => {
        externalValid.current = undefined;
        setExternal(IDLE);
      },
      targetAt: (payload, x, y) => {
        const accepts = (id: string): boolean => handlerFor(payload, id) !== undefined;
        const id = targetAt(x, y, accepts);
        return id !== undefined && accepts(id) ? id : undefined;
      },
    }),
    [handlerFor],
  );
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
      external: externalDrag,
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
    [state, controller, register, externalDrag],
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

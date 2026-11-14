// Drag and drop by pointer events, the React part (#63): one provider per window, sources and targets as props.
// Sources call `sourceProps(payload)` for their `onPointerDown`; targets carry `data-drop-target="<id>"` and take
// their look from `dropHighlight`. The provider owns the controller, the ghost at the pointer and the page state
// while dragging. What a drop does is up to the caller (`onDrop`).
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { DragController } from "./drag-controller.js";
import { dropHighlight, IDLE } from "./drag-model.js";
import type { DragPayload, DragState } from "./drag-model.js";

export const DROP_TARGET_ATTRIBUTE = "data-drop-target";

export interface DragApi {
  state: DragState;
  /** Props for a source element: its `pointerdown` starts a press. */
  sourceProps(payload: DragPayload): { onPointerDown: (event: ReactPointerEvent) => void };
  /** Class names for a drop target: `drop-target`, plus `--valid` and `--over` while dragging. */
  targetClass(targetId: string): string;
}

const DragContext = createContext<DragApi | undefined>(undefined);

export function useDrag(): DragApi {
  const api = useContext(DragContext);
  if (!api) throw new Error("useDrag needs a DragProvider");
  return api;
}

export interface DragProviderProps {
  /** Whether the target takes the payload; pure, the same rule the context menu uses. */
  accepts(payload: DragPayload, targetId: string): boolean;
  onDrop(payload: DragPayload, targetId: string): void;
  children: ReactNode;
}

/** Id of the drop target at the point, or undefined. */
function targetAt(x: number, y: number): string | undefined {
  const element = document.elementFromPoint(x, y)?.closest(`[${DROP_TARGET_ATTRIBUTE}]`);
  return element?.getAttribute(DROP_TARGET_ATTRIBUTE) ?? undefined;
}

function allTargets(): string[] {
  return [...document.querySelectorAll(`[${DROP_TARGET_ATTRIBUTE}]`)].map(
    (element) => element.getAttribute(DROP_TARGET_ATTRIBUTE) ?? "",
  );
}

export function DragProvider({ accepts, onDrop, children }: DragProviderProps) {
  const [state, setState] = useState<DragState>(IDLE);
  // The controller outlives renders; it reads the latest callbacks through the ref.
  const latest = useRef({ accepts, onDrop });
  latest.current = { accepts, onDrop };

  const controller = useMemo(
    () =>
      new DragController({
        host: window,
        hit: targetAt,
        targets: allTargets,
        accepts: (payload, targetId) => latest.current.accepts(payload, targetId),
        onChange: setState,
        onDrop: (payload, targetId) => latest.current.onDrop(payload, targetId),
        setDragging: (active) => document.body.classList.toggle("is-dragging", active),
      }),
    [],
  );
  useEffect(() => () => controller.dispose(), [controller]);

  const api = useMemo<DragApi>(
    () => ({
      state,
      sourceProps: (payload) => ({
        onPointerDown: (event) => controller.press(payload, event),
      }),
      targetClass: (targetId) => {
        const highlight = dropHighlight(state, targetId);
        return `drop-target${highlight === "none" ? "" : ` drop-target--valid${highlight === "over" ? " drop-target--over" : ""}`}`;
      },
    }),
    [state, controller],
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

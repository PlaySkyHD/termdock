// Context menu of the sidebar (#63): the keyboard alternative to drag and drop. Opens at the pointer (right click)
// or at the focused entry (menu key, Shift+F10: Chromium sends `contextmenu` for both). Arrow keys move through
// the enabled entries, Enter chooses, Escape or a press outside closes. The caller gives the focus back.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { nextMenuIndex } from "./menu-navigation.js";
import type { MenuKey } from "./menu-navigation.js";
import type { MenuEntry } from "./sidebar-model.js";

export interface ContextMenuProps {
  x: number;
  y: number;
  label: string;
  entries: readonly MenuEntry<() => void>[];
  /** Closes the menu; `chosen` is false for Escape and a press outside, so the caller can restore the focus. */
  onClose: (chosen: boolean) => void;
}

const NAVIGATION_KEYS: readonly string[] = ["ArrowDown", "ArrowUp", "Home", "End"];

export function ContextMenu({ x, y, label, entries, onClose }: ContextMenuProps) {
  const menu = useRef<HTMLDivElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const [position, setPosition] = useState({ left: x, top: y });
  const enabled = entries.map((entry) => entry.disabled !== true);

  // Keeps the menu inside the window.
  useLayoutEffect(() => {
    const box = menu.current?.getBoundingClientRect();
    if (!box) return;
    setPosition({
      left: Math.max(0, Math.min(x, window.innerWidth - box.width - 4)),
      top: Math.max(0, Math.min(y, window.innerHeight - box.height - 4)),
    });
  }, [x, y, entries]);

  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    items.current[enabled.findIndex(Boolean)]?.focus();
    // A press outside closes the menu; one inside is the entry's own click.
    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      close.current(false);
    };
    const onBlur = (): void => close.current(false);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("blur", onBlur);
    };
    // Once per opened menu: the entries of an open menu do not change.
  }, []);

  const choose = (index: number): void => {
    const entry = entries[index];
    if (!entry || entry.disabled) return;
    onClose(true);
    entry.action();
  };

  const onKeyDown = (event: ReactKeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose(false);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      onClose(false);
      return;
    }
    if (NAVIGATION_KEYS.includes(event.key)) {
      event.preventDefault();
      const current = items.current.findIndex((item) => item === document.activeElement);
      items.current[nextMenuIndex(enabled, current, event.key as MenuKey)]?.focus();
    }
  };

  return (
    <div
      className="context-menu"
      ref={menu}
      role="menu"
      aria-label={label}
      data-menu={label}
      style={position}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {entries.map((entry, index) => (
        <div key={entry.key} role="none">
          {entry.separator && <div className="context-menu__separator" role="separator" />}
          <button
            ref={(element) => void (items.current[index] = element)}
            className={`context-menu__item${entry.danger ? " context-menu__item--danger" : ""}`}
            type="button"
            role="menuitem"
            data-menu-item={entry.key}
            aria-disabled={entry.disabled === true || undefined}
            title={entry.disabled ? entry.hint : undefined}
            // Disabled entries stay out of the arrow keys but keep their tooltip.
            tabIndex={entry.disabled ? -1 : 0}
            onClick={() => choose(index)}
          >
            {entry.label}
          </button>
        </div>
      ))}
    </div>
  );
}

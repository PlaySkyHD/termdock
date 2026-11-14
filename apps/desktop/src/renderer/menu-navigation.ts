// Keyboard navigation of the context menu (#63): which entry gets the focus after an arrow key. Disabled entries
// are skipped; the menu wraps around. Pure, no DOM.

export type MenuKey = "ArrowDown" | "ArrowUp" | "Home" | "End";

/**
 * Index of the entry that takes the focus, or -1 when none is enabled. `current` is the focused entry, -1 when
 * none is focused (ArrowDown then starts at the first, ArrowUp at the last).
 */
export function nextMenuIndex(enabled: readonly boolean[], current: number, key: MenuKey): number {
  const count = enabled.length;
  if (!enabled.some(Boolean)) return -1;
  if (key === "Home") return enabled.findIndex(Boolean);
  if (key === "End") return enabled.lastIndexOf(true);
  const step = key === "ArrowDown" ? 1 : -1;
  let index = current < 0 || current >= count ? (step === 1 ? -1 : count) : current;
  for (let tried = 0; tried < count; tried += 1) {
    index = (index + step + count) % count;
    if (enabled[index]) return index;
  }
  return -1;
}

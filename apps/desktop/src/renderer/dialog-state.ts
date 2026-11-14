// What the dialogs of the sidebar do with the outcome of their action (#63). Pure, no DOM.

/** Message of a failed call for display; the preload puts the code in front as `[code]`. */
export function failureText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^\[[a-z_]+\]\s*/, "");
}

/**
 * The dialog after `own` has finished its action: closed when `own` is still the open one, otherwise the dialog the
 * user opened meanwhile (a slow archive can be cancelled with Escape and another dialog opened before it answers).
 */
export function closeIfCurrent<T>(current: T | undefined, own: T): T | undefined {
  return current === own ? undefined : current;
}

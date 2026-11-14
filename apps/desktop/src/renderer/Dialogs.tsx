// Small modal dialogs of the sidebar (#63): a confirmation (delete, archive) and a form with one or two text
// fields (create, rename). Both hold the focus (`trapFocus`), Escape cancels, a click beside the dialog does
// nothing, and a failure of the action stays in the dialog. The default of the confirmation is "Abbrechen".
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { trapFocus } from "./focus-trap.js";
import type { Confirmation } from "./sidebar-model.js";

/** Message of a failed call for display; the preload puts the code in front as `[code]`. */
export function failureText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^\[[a-z_]+\]\s*/, "");
}

/** Escape cancels wherever the focus is. */
function useEscape(onCancel: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);
}

function Backdrop({ children }: { children: ReactNode }) {
  return (
    // A press on the backdrop must not take the focus from the dialog.
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && event.preventDefault()}
    >
      {children}
    </div>
  );
}

export function ConfirmDialog({
  confirmation,
  onConfirm,
  onCancel,
}: {
  confirmation: Confirmation;
  /** Rejects with the reason; the dialog shows it and stays open. */
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const cancel = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    cancel.current?.focus();
    const release = dialog.current ? trapFocus(dialog.current, () => cancel.current) : undefined;
    return () => {
      mounted.current = false;
      release?.();
    };
  }, []);
  useEscape(onCancel);

  const confirm = (): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    onConfirm().then(
      () => undefined,
      (failure: unknown) => {
        if (!mounted.current) return;
        setBusy(false);
        setError(failureText(failure));
      },
    );
  };

  return (
    <Backdrop>
      <div
        className="dialog"
        ref={dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        data-dialog="confirm"
      >
        <h2 className="dialog__title" id="confirm-title">
          {confirmation.title}
        </h2>
        <p className="dialog__text" id="confirm-message" data-confirm="message">
          {confirmation.message}
        </p>
        {error && (
          <p className="new-session__error" data-confirm="error">
            {error}
          </p>
        )}
        <div className="dialog__actions dialog__actions--wrap">
          <button className="button" type="button" ref={cancel} data-confirm="cancel" onClick={onCancel}>
            Abbrechen
          </button>
          <button
            className="button button--danger"
            type="button"
            data-confirm="ok"
            disabled={busy}
            onClick={confirm}
          >
            {confirmation.confirm}
          </button>
        </div>
      </div>
    </Backdrop>
  );
}

export interface NameField {
  key: string;
  label: string;
  value: string;
  /** The first field is selected on open. */
  spellCheck?: boolean;
}

export function NameDialog({
  title,
  fields,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  title: string;
  fields: readonly NameField[];
  submitLabel: string;
  /** Receives the trimmed values in the order of `fields`; rejects with the reason, the dialog stays open. */
  onSubmit: (values: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState(() => fields.map((field) => field.value));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const first = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    first.current?.select();
    const release = form.current ? trapFocus(form.current, () => first.current) : undefined;
    return () => {
      mounted.current = false;
      release?.();
    };
  }, []);
  useEscape(onCancel);

  const valid = values.every((value) => value.trim() !== "");
  const submit = (): void => {
    if (busy || !valid) return;
    setBusy(true);
    setError(undefined);
    onSubmit(values.map((value) => value.trim())).then(
      () => undefined,
      (failure: unknown) => {
        if (!mounted.current) return;
        setBusy(false);
        setError(failureText(failure));
      },
    );
  };

  return (
    <Backdrop>
      <form
        className="dialog"
        ref={form}
        role="dialog"
        aria-modal="true"
        aria-labelledby="name-title"
        data-dialog="name"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <h2 className="dialog__title" id="name-title">
          {title}
        </h2>
        {fields.map((field, index) => (
          <label className="new-session__field dialog__field" key={field.key}>
            {field.label}
            <input
              ref={index === 0 ? first : undefined}
              value={values[index]}
              data-field={field.key}
              disabled={busy}
              spellCheck={field.spellCheck ?? false}
              onChange={(event) =>
                setValues(values.map((value, i) => (i === index ? event.target.value : value)))
              }
            />
          </label>
        ))}
        {error && (
          <p className="new-session__error" data-name="error">
            {error}
          </p>
        )}
        <div className="dialog__actions dialog__actions--wrap">
          <button className="button" type="button" data-name="cancel" disabled={busy} onClick={onCancel}>
            Abbrechen
          </button>
          <button className="button button--primary" type="submit" data-name="ok" disabled={busy || !valid}>
            {submitLabel}
          </button>
        </div>
      </form>
    </Backdrop>
  );
}

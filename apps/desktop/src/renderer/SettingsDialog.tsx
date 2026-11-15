// Settings dialog (#64, Ctrl+, and "Datei → Einstellungen …"): general settings, history, the key overview and the
// launch profiles. Modal like the other dialogs (focus trap, Escape closes, a click beside it does nothing); a
// failure of the core stays in the dialog. What goes to the core is built by the pure functions of
// `settings-form.ts`; the dialog keeps settings and profiles current through the core's events.
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { LaunchProfile, Settings, WindowsShell, WslDistrosResult } from "@termdock/protocol";
import type { TermdockApi } from "../shared/bridge.js";
import { failureText } from "./dialog-state.js";
import { trapFocus } from "./focus-trap.js";
import { overviewRows } from "./keymap.js";
import {
  emptyProfileForm,
  generalForm,
  generalPatch,
  historyForm,
  historyPatch,
  profileChange,
  profileCreateParams,
  profileToForm,
  rebaseGeneral,
  rebaseHistory,
} from "./settings-form.js";
import type { GeneralErrors, ProfileErrors, ProfileForm } from "./settings-form.js";

type SectionId = "general" | "history" | "shortcuts" | "profiles";

const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: "general", label: "Allgemein" },
  { id: "history", label: "Verlauf" },
  { id: "shortcuts", label: "Kürzel" },
  { id: "profiles", label: "Startprofile" },
];

const SHELLS: ReadonlyArray<{ value: WindowsShell | ""; label: string }> = [
  { value: "", label: "Keine Vorgabe" },
  { value: "pwsh", label: "PowerShell 7 (pwsh)" },
  { value: "powershell", label: "Windows PowerShell" },
  { value: "cmd", label: "Eingabeaufforderung (cmd)" },
];

type Api = Pick<
  TermdockApi,
  | "getSettings"
  | "updateSettings"
  | "listProfiles"
  | "createProfile"
  | "updateProfile"
  | "deleteProfile"
  | "listDistros"
  | "onEvent"
>;

export function SettingsDialog({ api, onClose }: { api: Api; onClose: () => void }) {
  const [section, setSection] = useState<SectionId>("general");
  const [settings, setSettings] = useState<Settings>();
  const [profiles, setProfiles] = useState<LaunchProfile[]>();
  const [distros, setDistros] = useState<WslDistrosResult>();
  const [loadError, setLoadError] = useState<string>();
  const dialog = useRef<HTMLDivElement>(null);
  const firstTab = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let current = true;
    // An event is never older than an answer that arrives after it: once one came, the answer is dropped.
    let settingsEvent = false;
    let profilesEvent = false;
    const off = api.onEvent((event) => {
      if (event.kind === "settingsChanged") {
        settingsEvent = true;
        setSettings(event.settings);
      } else if (event.kind === "profilesChanged") {
        profilesEvent = true;
        setProfiles(event.profiles);
      }
    });
    const failed = (error: unknown): void => {
      if (current) setLoadError(failureText(error));
    };
    api.getSettings().then((value) => current && !settingsEvent && setSettings(value), failed);
    api.listProfiles().then((value) => current && !profilesEvent && setProfiles(value), failed);
    // A core before protocol 1.4 does not know the method: the field for the distribution is then free text.
    api.listDistros().then(
      (value) => current && setDistros(value),
      (error: unknown) => current && setDistros({ distros: [], unavailable: failureText(error) }),
    );
    return () => {
      current = false;
      off();
    };
  }, [api]);

  useEffect(() => {
    // Takes the focus from the terminal, so the keys of the dialog never reach the shell.
    firstTab.current?.focus();
    return dialog.current ? trapFocus(dialog.current, () => firstTab.current) : undefined;
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    // A press on the backdrop must not take the focus from the dialog.
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && event.preventDefault()}
    >
      <div
        className="dialog dialog--settings"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        data-dialog="settings"
        data-settings-section={section}
      >
        <h2 className="dialog__title" id="settings-title">
          Einstellungen
        </h2>
        <div className="settings">
          <div className="settings__nav" role="tablist" aria-orientation="vertical">
            {SECTIONS.map((entry, index) => (
              <button
                key={entry.id}
                ref={index === 0 ? firstTab : undefined}
                type="button"
                role="tab"
                id={`settings-tab-${entry.id}`}
                aria-selected={section === entry.id}
                aria-controls="settings-panel"
                className={`settings__tab${section === entry.id ? " settings__tab--active" : ""}`}
                data-settings-tab={entry.id}
                onClick={() => setSection(entry.id)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <div
            className="settings__panel"
            id="settings-panel"
            role="tabpanel"
            aria-labelledby={`settings-tab-${section}`}
          >
            {loadError && (
              <p className="new-session__error" data-settings="load-error">
                Einstellungen nicht verfügbar: {loadError}
              </p>
            )}
            {/* Every section stays mounted while the dialog is open and is only hidden: a change of section keeps
                what the user typed in another one (spec desktop-shell). */}
            <div hidden={section !== "general"}>
              {settings ? (
                <GeneralSection api={api} settings={settings} distros={distros} onSaved={setSettings} />
              ) : (
                <Loading />
              )}
            </div>
            <div hidden={section !== "history"}>
              {settings ? (
                <HistorySection api={api} settings={settings} onSaved={setSettings} />
              ) : (
                <Loading />
              )}
            </div>
            <div hidden={section !== "shortcuts"}>
              <ShortcutsSection />
            </div>
            <div hidden={section !== "profiles"}>
              {profiles && settings ? (
                <ProfilesSection
                  api={api}
                  profiles={profiles}
                  distros={distros}
                  loggingByDefault={settings.historyEnabledByDefault}
                  onProfiles={setProfiles}
                />
              ) : (
                <Loading />
              )}
            </div>
          </div>
        </div>
        <div className="dialog__actions">
          <button className="button" type="button" data-settings-action="close" onClick={onClose}>
            Schließen
          </button>
        </div>
      </div>
    </div>
  );
}

function Loading() {
  return <p className="dialog__note">Wird geladen …</p>;
}

/** Saving of a section: busy while the core works, its error or a short confirmation afterwards. */
function useSave() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const run = (work: () => Promise<string | undefined>): void => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setDone(undefined);
    work().then(
      (message) => {
        if (!mounted.current) return;
        setBusy(false);
        setDone(message);
      },
      (failure: unknown) => {
        if (!mounted.current) return;
        setBusy(false);
        setError(failureText(failure));
      },
    );
  };
  return { busy, error, done, run, clear: () => setDone(undefined) };
}

function Field({
  label,
  error,
  note,
  children,
}: {
  label: string;
  error?: string | undefined;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="settings__field">
      <span className="settings__label">{label}</span>
      {children}
      {note && <span className="settings__hint">{note}</span>}
      {error && (
        <span className="settings__field-error" data-field-error>
          {error}
        </span>
      )}
    </label>
  );
}

function SaveRow({ save, label = "Speichern" }: { save: ReturnType<typeof useSave>; label?: string }) {
  return (
    <>
      {save.error && (
        <p className="new-session__error" data-settings="error">
          {save.error}
        </p>
      )}
      {save.done && (
        <p className="dialog__note" data-settings="saved">
          {save.done}
        </p>
      )}
      <div className="settings__actions">
        <button
          className="button button--primary"
          type="submit"
          data-settings-action="save"
          disabled={save.busy}
        >
          {label}
        </button>
      </div>
    </>
  );
}

function DistroField({
  value,
  distros,
  error,
  allowDefault,
  onChange,
}: {
  value: string;
  distros: WslDistrosResult | undefined;
  error?: string | undefined;
  allowDefault: string;
  onChange: (value: string) => void;
}) {
  if (distros && distros.distros.length > 0) {
    const names =
      distros.distros.includes(value) || value === "" ? distros.distros : [...distros.distros, value];
    return (
      <Field label="Distribution" error={error}>
        <select value={value} data-field="distro" onChange={(event) => onChange(event.target.value)}>
          <option value="">
            {allowDefault}
            {distros.defaultDistro ? ` (${distros.defaultDistro})` : ""}
          </option>
          {names.map((name) => (
            <option key={name} value={name}>
              {distros.distros.includes(name) ? name : `${name} (nicht gefunden)`}
            </option>
          ))}
        </select>
      </Field>
    );
  }
  const reason =
    distros === undefined ? "Liste wird geladen …" : (distros.unavailable ?? "Keine Distribution gefunden");
  return (
    <Field
      label="Distribution"
      error={error}
      note={
        <span data-settings="distro-unavailable">
          WSL-Liste nicht verfügbar: {reason}. Leer heißt {allowDefault}.
        </span>
      }
    >
      <input
        value={value}
        data-field="distro"
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function GeneralSection({
  api,
  settings,
  distros,
  onSaved,
}: {
  api: Api;
  settings: Settings;
  distros: WslDistrosResult | undefined;
  onSaved: (settings: Settings) => void;
}) {
  // The form keeps what the user types. New settings (`settings.changed`, own save) go into the fields the user has
  // not touched and become the `base` of the patch, so a field set back to its old value still reaches the core.
  const [base, setBase] = useState(settings);
  const [form, setForm] = useState(() => generalForm(settings));
  if (settings !== base) {
    // Adjusting state while rendering (React): no frame shows the old values.
    setForm(rebaseGeneral(form, base, settings));
    setBase(settings);
  }
  const [errors, setErrors] = useState<GeneralErrors>({});
  const save = useSave();
  const submit = (): void => {
    const result = generalPatch(base, form);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    if (Object.keys(result.patch).length === 0) {
      save.run(async () => "Keine Änderungen.");
      return;
    }
    save.run(async () => {
      // The answer becomes the dialog's settings; the rebase above takes it into the form.
      onSaved(await api.updateSettings(result.patch));
      return "Gespeichert.";
    });
  };
  return (
    <form
      className="settings__form"
      data-settings-form="general"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <DistroField
        value={form.distro}
        distros={distros}
        error={errors.distro}
        allowDefault="WSL-Standard"
        onChange={(distro) => setForm({ ...form, distro })}
      />
      <Field label="Standardshell (Windows)">
        <select
          value={form.shell}
          data-field="shell"
          onChange={(event) => setForm({ ...form, shell: event.target.value as WindowsShell | "" })}
        >
          {SHELLS.map((shell) => (
            <option key={shell.value} value={shell.value}>
              {shell.label}
            </option>
          ))}
        </select>
      </Field>
      <Field
        label="Standardverzeichnis"
        error={errors.cwd}
        note="Für Startprofile ohne eigenes Verzeichnis, wenn weder Projekt noch Workspace eines vorgeben. Leer: Home-Verzeichnis."
      >
        <input
          value={form.cwd}
          data-field="cwd"
          placeholder="/home/dev oder C:\dev"
          spellCheck={false}
          onChange={(event) => setForm({ ...form, cwd: event.target.value })}
        />
      </Field>
      <label className="dialog__check settings__check">
        <input
          type="checkbox"
          data-field="confirmQuit"
          checked={form.confirmQuit}
          onChange={(event) => setForm({ ...form, confirmQuit: event.target.checked })}
        />
        Beim Schließen fragen, wenn Sessions laufen
      </label>
      {!settings.confirmQuitWhileRunning && (
        <p className="dialog__note" data-settings="quit-action">
          Ohne Nachfrage gilt die gespeicherte Wahl:{" "}
          {settings.quitAction === "stopSessions" ? "Sessions beenden" : "Sessions weiterlaufen lassen"}.
        </p>
      )}
      <SaveRow save={save} />
    </form>
  );
}

function HistorySection({
  api,
  settings,
  onSaved,
}: {
  api: Api;
  settings: Settings;
  onSaved: (settings: Settings) => void;
}) {
  // Like the general section: new settings go into untouched fields and become the base of the patch.
  const [base, setBase] = useState(settings);
  const [form, setForm] = useState(() => historyForm(settings));
  if (settings !== base) {
    setForm(rebaseHistory(form, base, settings));
    setBase(settings);
  }
  const [error, setError] = useState<string>();
  const save = useSave();
  const submit = (): void => {
    const result = historyPatch(base, form);
    if (!result.ok) {
      setError(result.errors.limit);
      return;
    }
    setError(undefined);
    if (Object.keys(result.patch).length === 0) {
      save.run(async () => "Keine Änderungen.");
      return;
    }
    save.run(async () => {
      onSaved(await api.updateSettings(result.patch));
      return "Gespeichert.";
    });
  };
  return (
    <form
      className="settings__form"
      data-settings-form="history"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Field label="Limit je Session (MiB)" error={error} note="Von 0,0625 (64 KiB) bis 1024 MiB.">
        <input
          value={form.limitMiB}
          data-field="limit"
          inputMode="decimal"
          onChange={(event) => setForm({ ...form, limitMiB: event.target.value })}
        />
      </Field>
      <label className="dialog__check settings__check">
        <input
          type="checkbox"
          data-field="historyDefault"
          checked={form.enabledByDefault}
          onChange={(event) => setForm({ ...form, enabledByDefault: event.target.checked })}
        />
        Verlauf für neue Sessions aufzeichnen
      </label>
      <p className="dialog__note settings__notice" data-settings="history-note">
        Der Verlauf liegt unverschlüsselt auf der Platte (im Datenverzeichnis von TermDock unter{" "}
        <code>history</code>). Löschen einer Session entfernt ihn; Archivieren behält ihn.
      </p>
      <SaveRow save={save} />
    </form>
  );
}

function ShortcutsSection() {
  return (
    <div data-settings-form="shortcuts">
      <table className="shortcuts">
        <tbody>
          {overviewRows().map((row) => (
            <tr key={row.command} data-command={row.command}>
              <td>{row.label}</td>
              <td className="shortcuts__keys">
                <kbd>{row.shortcut}</kbd>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="dialog__note">Die Belegung lässt sich noch nicht ändern.</p>
    </div>
  );
}

type Editing = { mode: "new" } | { mode: "edit"; profile: LaunchProfile };

function ProfilesSection({
  api,
  profiles,
  distros,
  loggingByDefault,
  onProfiles,
}: {
  api: Api;
  profiles: LaunchProfile[];
  distros: WslDistrosResult | undefined;
  loggingByDefault: boolean;
  onProfiles: (update: (current: LaunchProfile[] | undefined) => LaunchProfile[] | undefined) => void;
}) {
  const [editing, setEditing] = useState<Editing>();
  const [confirming, setConfirming] = useState<string>();
  const remove = useSave();

  if (editing) {
    const original = editing.mode === "edit" ? editing.profile : undefined;
    return (
      <ProfileEditor
        key={original?.id ?? "new"}
        initial={original ? profileToForm(original) : emptyProfileForm(loggingByDefault)}
        isNew={original === undefined}
        distros={distros}
        onCancel={() => setEditing(undefined)}
        // The list follows `profilesChanged` only: an answer can be older than an event that came before it (a
        // delete by another window) and must not bring a profile back.
        onSave={async (form) => {
          if (!original) {
            const result = profileCreateParams(form);
            if (!result.ok) return result.errors;
            await api.createProfile(result.params);
          } else {
            const result = profileChange(original, form);
            if (!result.ok) return result.errors;
            if (Object.keys(result.change).length > 0) await api.updateProfile(original.id, result.change);
          }
          setEditing(undefined);
          return undefined;
        }}
      />
    );
  }

  return (
    <div className="settings__form" data-settings-form="profiles">
      {profiles.length === 0 ? (
        <p className="dialog__note" data-settings="no-profiles">
          Noch keine Startprofile.
        </p>
      ) : (
        <ul className="profiles">
          {profiles.map((profile) => (
            <li className="profiles__row" key={profile.id} data-profile-name={profile.name}>
              <div className="profiles__main">
                <span className="profiles__name">{profile.name}</span>
                <span className="profiles__meta">
                  {launchLabel(profile)}
                  {profile.autostart ? " · Autostart" : ""}
                  {profile.loggingEnabled ? "" : " · ohne Verlauf"}
                </span>
                <code className="profiles__command" title={(profile.launch.command ?? []).join("\n")}>
                  {commandLabel(profile)}
                </code>
              </div>
              {confirming === profile.id ? (
                <div className="profiles__actions" data-profile-confirm>
                  <span>Löschen?</span>
                  <button
                    className="button"
                    type="button"
                    data-profile-action="cancel-delete"
                    onClick={() => setConfirming(undefined)}
                  >
                    Abbrechen
                  </button>
                  <button
                    className="button button--danger"
                    type="button"
                    data-profile-action="confirm-delete"
                    disabled={remove.busy}
                    onClick={() =>
                      remove.run(async () => {
                        await api.deleteProfile(profile.id);
                        onProfiles((current) => current?.filter((each) => each.id !== profile.id));
                        setConfirming(undefined);
                        return undefined;
                      })
                    }
                  >
                    Löschen
                  </button>
                </div>
              ) : (
                <div className="profiles__actions">
                  <button
                    className="button"
                    type="button"
                    data-profile-action="edit"
                    onClick={() => setEditing({ mode: "edit", profile })}
                  >
                    Bearbeiten
                  </button>
                  <button
                    className="button"
                    type="button"
                    data-profile-action="delete"
                    onClick={() => setConfirming(profile.id)}
                  >
                    Löschen
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {remove.error && (
        <p className="new-session__error" data-settings="error">
          {remove.error}
        </p>
      )}
      <div className="settings__actions">
        <button
          className="button button--primary"
          type="button"
          data-profile-action="new"
          onClick={() => setEditing({ mode: "new" })}
        >
          Neues Profil
        </button>
      </div>
    </div>
  );
}

function ProfileEditor({
  initial,
  isNew,
  distros,
  onSave,
  onCancel,
}: {
  initial: ProfileForm;
  isNew: boolean;
  distros: WslDistrosResult | undefined;
  /** Resolves with the field errors of the form, or undefined when saved; rejects with the core's refusal. */
  onSave: (form: ProfileForm) => Promise<ProfileErrors | undefined>;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<ProfileErrors>({});
  const save = useSave();
  const name = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLFormElement>(null);
  useEffect(() => name.current?.focus(), []);
  // Escape in the open editor goes back to the list first; a second Escape closes the dialog. Captured before the
  // dialog's own listener, and only while the section is shown (a hidden section keeps its editor mounted).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || root.current?.offsetParent === null || root.current === null) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);
  const set = <K extends keyof ProfileForm>(key: K, value: ProfileForm[K]): void =>
    setForm({ ...form, [key]: value });
  const submit = (): void => {
    setErrors({});
    save.run(async () => {
      // Saved: the list replaces the editor. Otherwise the messages go to their fields.
      const fieldErrors = await onSave(form);
      if (fieldErrors) setErrors(fieldErrors);
      return undefined;
    });
  };
  return (
    <form
      ref={root}
      className="settings__form"
      data-settings-form="profile-editor"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <h3 className="settings__subtitle">
        {isNew ? "Neues Startprofil" : `Profil „${initial.name}“ bearbeiten`}
      </h3>
      <Field label="Name" error={errors.name}>
        <input
          ref={name}
          value={form.name}
          data-field="name"
          onChange={(event) => set("name", event.target.value)}
        />
      </Field>
      <Field label="Backend">
        <select
          value={form.backend}
          data-field="backend"
          onChange={(event) => set("backend", event.target.value === "windows" ? "windows" : "wsl")}
        >
          <option value="wsl">WSL</option>
          <option value="windows">Windows</option>
        </select>
      </Field>
      {form.backend === "wsl" ? (
        <DistroField
          value={form.distro}
          distros={distros}
          error={errors.distro}
          allowDefault="Standard aus den Einstellungen"
          onChange={(distro) => set("distro", distro)}
        />
      ) : (
        <Field label="Shell">
          <select
            value={form.shell}
            data-field="shell"
            onChange={(event) => set("shell", event.target.value as WindowsShell | "")}
          >
            {SHELLS.map((shell) => (
              <option key={shell.value} value={shell.value}>
                {shell.value === "" ? "Standard aus den Einstellungen" : shell.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field
        label="Verzeichnis"
        error={errors.cwd}
        note="Leer oder ~: Projekt, Workspace oder Standardverzeichnis."
      >
        <input
          value={form.cwd}
          data-field="cwd"
          spellCheck={false}
          placeholder={form.backend === "wsl" ? "/home/dev/app" : "C:\\dev\\app"}
          onChange={(event) => set("cwd", event.target.value)}
        />
      </Field>
      <Field
        label="Befehl (ein Argument je Zeile)"
        error={errors.command}
        note="Leer: Login-Shell. Zeilen werden nie an Leerzeichen geteilt und nicht von einer Shell gelesen."
      >
        <textarea
          value={form.command}
          data-field="command"
          rows={3}
          spellCheck={false}
          onChange={(event) => set("command", event.target.value)}
        />
      </Field>
      <Field
        label="Umgebung (NAME=Wert je Zeile)"
        error={errors.env}
        note={
          <span data-settings="secret-note">
            Keine Zugangsdaten hier: Tokens und Passwörter kommen aus dem Login der CLI oder einer geschützten
            Umgebungsvariable, nie aus einem Profil.
          </span>
        }
      >
        <textarea
          value={form.env}
          data-field="env"
          rows={2}
          spellCheck={false}
          onChange={(event) => set("env", event.target.value)}
        />
      </Field>
      <label className="dialog__check settings__check">
        <input
          type="checkbox"
          data-field="autostart"
          checked={form.autostart}
          onChange={(event) => set("autostart", event.target.checked)}
        />
        Beim Start des Core automatisch starten
      </label>
      <label className="dialog__check settings__check">
        <input
          type="checkbox"
          data-field="logging"
          checked={form.loggingEnabled}
          onChange={(event) => set("loggingEnabled", event.target.checked)}
        />
        Verlauf aufzeichnen
      </label>
      {save.error && (
        <p className="new-session__error" data-settings="error">
          {save.error}
        </p>
      )}
      <div className="settings__actions">
        <button
          className="button"
          type="button"
          data-profile-action="cancel"
          disabled={save.busy}
          onClick={onCancel}
        >
          Abbrechen
        </button>
        <button
          className="button button--primary"
          type="submit"
          data-settings-action="save"
          disabled={save.busy}
        >
          {isNew ? "Anlegen" : "Speichern"}
        </button>
      </div>
    </form>
  );
}

function launchLabel(profile: LaunchProfile): string {
  const { launch } = profile;
  const where = launch.cwd === "~" ? "Standardverzeichnis" : launch.cwd;
  if (launch.backend === "wsl") return `WSL${launch.distro ? ` · ${launch.distro}` : ""} · ${where}`;
  return `Windows${launch.shell ? ` · ${launch.shell}` : ""} · ${where}`;
}

/** The arguments side by side for the list; the editor shows one per line. */
function commandLabel(profile: LaunchProfile): string {
  const command = profile.launch.command ?? [];
  if (command.length === 0) return "Login-Shell";
  return command.map((arg) => (/[\s"]/.test(arg) || arg === "" ? JSON.stringify(arg) : arg)).join(" ");
}

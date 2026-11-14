import type { TerminalSize } from "@termdock/protocol";
import { describe, expect, it, vi } from "vitest";
import type { AttachedView, BridgeEvent, TermdockApi } from "../shared/bridge.js";
import { TerminalController } from "./terminal-controller.js";
import type { KeyEvent, TerminalSurface, ViewStatus } from "./terminal-controller.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (data: Uint8Array | string): string =>
  typeof data === "string" ? data : new TextDecoder().decode(data);

/** xterm.js stand-in: records what is written and how big it is; `area` is what would fit the element. */
class FakeSurface implements TerminalSurface {
  cols = 80;
  rows = 24;
  area: TerminalSize = { cols: 120, rows: 40 };
  screen: string[] = [];
  cursorShown = false;
  showCursor(): void {
    this.cursorShown = true;
  }
  private listener: ((data: string) => void) | undefined;

  write(data: Uint8Array | string): void {
    this.screen.push(decode(data));
  }
  reset(): void {
    this.screen = ["<reset>"];
  }
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
  proposeSize(): TerminalSize | undefined {
    return this.area;
  }
  onData(listener: (data: string) => void): () => void {
    this.listener = listener;
    return () => (this.listener = undefined);
  }
  /** What xterm.js does on a key press or on an automatic reply (DA1, cursor position). */
  emitData(data: string): void {
    this.listener?.(data);
  }

  private keyHandler: ((event: KeyEvent) => boolean) | undefined;
  onKey(handler: (event: KeyEvent) => boolean): void {
    this.keyHandler = handler;
  }
  /** What xterm.js asks its custom handler before it processes a key; true means it may. */
  pressKey(event: KeyEvent): boolean {
    return this.keyHandler?.(event) ?? true;
  }

  selection = "";
  /** The application asked for bracketed paste (`ESC [ ? 2004 h`). */
  bracketedPaste = false;
  getSelection(): string {
    return this.selection;
  }
  /** What `Terminal.paste` of xterm.js does: line breaks become CR, bracketed paste wraps; the result is data. */
  paste(text: string): void {
    const data = text.replace(/\r?\n/g, "\r");
    this.emitData(this.bracketedPaste ? `\x1b[200~${data}\x1b[201~` : data);
  }
}

/** Bridge double: `attach` waits until the test releases it, so output can arrive before the answer. */
class FakeApi implements TermdockApi {
  listeners = new Set<(event: BridgeEvent) => void>();
  inputs: Array<[string, string]> = [];
  resizes: Array<[string, TerminalSize]> = [];
  claims: string[] = [];
  detached: string[] = [];
  attachCalls: Array<[string, TerminalSize]> = [];
  claimError: Error | undefined;
  private release: ((view: AttachedView) => void) | undefined;
  private refuse: ((error: Error) => void) | undefined;

  coreStatus = vi.fn(async () => ({ backendUnavailable: [] }));
  listSessions = vi.fn(async () => []);
  createSession = vi.fn();
  windowLayout = vi.fn();
  reportLayout = vi.fn(async () => {});
  attach(sessionId: string, size: TerminalSize): Promise<AttachedView> {
    this.attachCalls.push([sessionId, size]);
    return new Promise((resolve, reject) => {
      this.release = resolve;
      this.refuse = reject;
    });
  }
  async detach(viewId: string): Promise<void> {
    this.detached.push(viewId);
  }
  async input(viewId: string, data: string): Promise<void> {
    this.inputs.push([viewId, data]);
  }
  async resize(viewId: string, size: TerminalSize): Promise<void> {
    this.resizes.push([viewId, size]);
  }
  async claimWriter(viewId: string): Promise<void> {
    this.claims.push(viewId);
    if (this.claimError) throw this.claimError;
  }
  onEvent(listener: (event: BridgeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: BridgeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
  answerAttach(view: Partial<AttachedView> = {}): void {
    this.release?.({
      viewId: "v1",
      size: { cols: 100, rows: 30 },
      snapshot: bytes("snap"),
      outputSeq: 0,
      ...view,
    });
  }
  failAttach(error: Error): void {
    this.refuse?.(error);
  }
  output(sessionId: string, seq: number, text: string): void {
    this.emit({ kind: "output", sessionId, seq, data: bytes(text) });
  }
}

/** Stand-in for the layout delay: what is planned runs only on `elapse()`. */
class ManualDelay {
  planned: Array<() => void> = [];
  readonly schedule = (run: () => void): (() => void) => {
    this.planned.push(run);
    return () => (this.planned = this.planned.filter((each) => each !== run));
  };
  elapse(): void {
    for (const run of this.planned.splice(0)) run();
  }
}

async function opened(view: Partial<AttachedView>) {
  const api = new FakeApi();
  const surface = new FakeSurface();
  const statuses: ViewStatus[] = [];
  const delay = new ManualDelay();
  const controller = new TerminalController(api, surface, (status) => statuses.push(status), {
    scheduleLayout: delay.schedule,
  });
  const opening = controller.open("s1");
  api.answerAttach(view);
  await opening;
  return { api, surface, controller, statuses, delay };
}

describe("TerminalController", () => {
  it("attaches with the size that fits and shows the snapshot before live output that came first", async () => {
    const api = new FakeApi();
    const surface = new FakeSurface();
    const controller = new TerminalController(api, surface, () => {});

    const opening = controller.open("s1");
    api.output("s1", 1, "early");
    api.output("other", 1, "not mine");
    api.answerAttach({ writerViewId: "v1" });
    await opening;
    api.output("s1", 2, "late");

    expect(api.attachCalls).toEqual([["s1", { cols: 120, rows: 40 }]]);
    expect(surface.screen).toEqual(["<reset>", "snap", "early", "late"]);
  });

  it("drops buffered and late output the snapshot already contains", async () => {
    const api = new FakeApi();
    const surface = new FakeSurface();
    const controller = new TerminalController(api, surface, () => {});

    const opening = controller.open("s1");
    api.output("s1", 4, "in snapshot");
    api.output("s1", 5, "also in snapshot");
    api.output("s1", 6, "new");
    api.answerAttach({ writerViewId: "v1", outputSeq: 5 });
    await opening;
    api.output("s1", 5, "in snapshot, late");
    api.output("s1", 7, "newer");

    expect(surface.screen).toEqual(["<reset>", "snap", "new", "newer"]);
  });

  it("stops listening and buffering when the attach fails", async () => {
    const api = new FakeApi();
    const surface = new FakeSurface();
    const statuses: ViewStatus[] = [];
    const controller = new TerminalController(api, surface, (status) => statuses.push(status));

    const opening = controller.open("s1");
    api.failAttach(new Error("[not_found] Unknown session s1"));
    await opening;
    api.output("s1", 1, "late");
    surface.emitData("x");

    expect(statuses.at(-1)).toMatchObject({ role: "error", error: "[not_found] Unknown session s1" });
    expect(api.listeners.size).toBe(0);
    expect(surface.screen).toEqual([]);
    expect(api.inputs).toEqual([]);
  });

  it("reports nothing when it was disposed before the attach failed", async () => {
    const api = new FakeApi();
    const surface = new FakeSurface();
    const statuses: ViewStatus[] = [];
    const controller = new TerminalController(api, surface, (status) => statuses.push(status));

    const opening = controller.open("s1");
    await controller.dispose();
    api.failAttach(new Error("[closed] Window closed or reloaded during attach"));
    await opening;

    expect(statuses).toEqual([]);
  });

  it("shows the snapshot in the session's size and keeps the cursor behind the last non-empty line", async () => {
    const api = new FakeApi();
    const surface = new FakeSurface();
    const sizes: string[] = [];
    const write = surface.write.bind(surface);
    surface.write = (data) => {
      sizes.push(`${surface.cols}x${surface.rows}`);
      write(data);
    };
    const controller = new TerminalController(api, surface, () => {});

    const opening = controller.open("s1");
    // capture-pane lists every row of the pane; the shell's cursor sits behind the prompt.
    api.answerAttach({ writerViewId: "v0", snapshot: bytes("out\r\nuser@host:~$ \r\n\x1b[0m\r\n \r\n") });
    await opening;

    expect(sizes[0]).toBe("100x30");
    expect(surface.screen).toEqual(["<reset>", "out\r\nuser@host:~$ \x1b[0m"]);
  });

  it("shows the cursor of the snapshot also in a reader that never had the focus", async () => {
    const { surface } = await opened({ writerViewId: "v0" });

    expect(surface.cursorShown).toBe(true);
  });

  it("keeps control sequences the core appended behind the blank rows, without the rows", async () => {
    const api = new FakeApi();
    const surface = new FakeSurface();
    const controller = new TerminalController(api, surface, () => {});

    const opening = controller.open("s1");
    // Output during the capture (here tmux toggling the cursor) is appended to the snapshot.
    api.answerAttach({ snapshot: bytes("user@host:~$ \r\n\r\n\r\n\x1b[?25l\x1b[?12l\x1b[?25h") });
    await opening;

    expect(surface.screen).toEqual(["<reset>", "user@host:~$ \x1b[?25l\x1b[?12l\x1b[?25h"]);
  });

  it("trusts writer and size events that arrive during the attach over the attach answer", async () => {
    const api = new FakeApi();
    const surface = new FakeSurface();
    const controller = new TerminalController(api, surface, () => {});

    const opening = controller.open("s1");
    api.emit({ kind: "writerChanged", sessionId: "s1", writerViewId: "v2" });
    api.emit({ kind: "resized", sessionId: "s1", size: { cols: 90, rows: 25 } });
    api.answerAttach({ writerViewId: "v1", size: { cols: 100, rows: 30 } });
    await opening;
    surface.emitData("x");

    expect(api.inputs).toEqual([]);
    expect([surface.cols, surface.rows]).toEqual([90, 25]);
  });

  it("as writer sends typed input and its own size", async () => {
    const { api, surface, statuses } = await opened({ writerViewId: "v1" });

    surface.emitData("ls --color\r");

    expect(api.inputs).toEqual([["v1", "ls --color\r"]]);
    expect(api.resizes).toEqual([["v1", { cols: 120, rows: 40 }]]);
    expect([surface.cols, surface.rows]).toEqual([120, 40]);
    expect(statuses.at(-1)).toMatchObject({ role: "writer", size: { cols: 120, rows: 40 } });
  });

  it("as writer follows a smaller area and sends the new size once", async () => {
    const { api, surface, controller, delay } = await opened({ writerViewId: "v1" });

    surface.area = { cols: 70, rows: 20 };
    controller.layoutChanged();
    delay.elapse();
    controller.layoutChanged();
    delay.elapse();

    expect(api.resizes).toEqual([
      ["v1", { cols: 120, rows: 40 }],
      ["v1", { cols: 70, rows: 20 }],
    ]);
  });

  it("as writer bundles area changes within the delay into one resize with the last size", async () => {
    const { api, surface, controller, delay } = await opened({ writerViewId: "v1" });

    for (const cols of [110, 100, 90]) {
      surface.area = { cols, rows: 40 };
      controller.layoutChanged();
    }
    expect(api.resizes).toHaveLength(1); // only the fit after the attach
    expect(delay.planned).toHaveLength(1);
    delay.elapse();

    expect(api.resizes.slice(1)).toEqual([["v1", { cols: 90, rows: 40 }]]);
    expect([surface.cols, surface.rows]).toEqual([90, 40]);
  });

  it("sends nothing for an area that cannot be measured", async () => {
    const { api, surface, controller, delay } = await opened({ writerViewId: "v1" });
    surface.proposeSize = () => undefined;

    controller.layoutChanged();
    delay.elapse();

    expect(api.resizes).toHaveLength(1);
  });

  it("drops a planned layout when it is disposed", async () => {
    const { api, surface, controller, delay } = await opened({ writerViewId: "v1" });
    surface.area = { cols: 70, rows: 20 };

    controller.layoutChanged();
    await controller.dispose();
    delay.elapse();

    expect(api.resizes).toHaveLength(1);
  });

  it("as reader drops input and automatic replies and shows the writer's size", async () => {
    const { api, surface, controller, statuses, delay } = await opened({ writerViewId: "v0" });

    surface.emitData("typed");
    surface.emitData("\x1b[?1;2c");
    surface.area = { cols: 50, rows: 10 };
    controller.layoutChanged();
    delay.elapse();

    expect(api.inputs).toEqual([]);
    expect(api.resizes).toEqual([]);
    expect([surface.cols, surface.rows]).toEqual([100, 30]);
    expect(statuses.at(-1)).toMatchObject({ role: "reader", size: { cols: 100, rows: 30 } });
  });

  it("as reader follows resizes of the writer", async () => {
    const { api, surface } = await opened({ writerViewId: "v0" });

    api.emit({ kind: "resized", sessionId: "s1", size: { cols: 90, rows: 25 } });

    expect([surface.cols, surface.rows]).toEqual([90, 25]);
  });

  it("claims the writer on request and becomes writer only when the core reports it", async () => {
    const { api, surface, controller, statuses } = await opened({ writerViewId: "v0" });

    await controller.claimWriter();
    surface.emitData("before");
    api.emit({ kind: "writerChanged", sessionId: "s1", writerViewId: "v1" });
    surface.emitData("after");

    expect(api.claims).toEqual(["v1"]);
    expect(api.inputs).toEqual([["v1", "after"]]);
    expect(api.resizes).toEqual([["v1", { cols: 120, rows: 40 }]]);
    expect(statuses.at(-1)).toMatchObject({ role: "writer" });
  });

  it("becomes reader when another view takes the writer and offers the claim when nobody writes", async () => {
    const { api, surface, statuses } = await opened({ writerViewId: "v1" });

    api.emit({ kind: "writerChanged", sessionId: "s1", writerViewId: "v2" });
    surface.emitData("x");
    api.emit({ kind: "writerChanged", sessionId: "s1" });

    expect(api.inputs).toEqual([]);
    expect(statuses.at(-1)).toMatchObject({ role: "reader" });
  });

  it("reports a lost core", async () => {
    const { api, statuses } = await opened({ writerViewId: "v1" });

    api.emit({ kind: "coreClosed" });
    expect(statuses.at(-1)).toMatchObject({ role: "closed" });
  });

  it("stays closed after the core is gone: no role change, no input, no resize", async () => {
    const { api, surface, controller, statuses, delay } = await opened({ writerViewId: "v1" });
    const resizesBefore = api.resizes.length;

    api.emit({ kind: "coreClosed" });
    api.emit({ kind: "writerChanged", sessionId: "s1", writerViewId: "v1" });
    surface.area = { cols: 60, rows: 20 };
    controller.layoutChanged();
    delay.elapse();
    surface.emitData("x");
    await controller.claimWriter();

    expect(statuses.at(-1)).toMatchObject({ role: "closed" });
    expect(api.inputs).toEqual([]);
    expect(api.resizes.length).toBe(resizesBefore);
    expect(api.claims).toEqual([]);
  });

  it("shows a refused writer claim in its status instead of losing it", async () => {
    const { api, controller, statuses } = await opened({ writerViewId: "v0" });
    api.claimError = new Error("[not_found] View v1 does not belong to this window");

    await expect(controller.claimWriter()).resolves.toBeUndefined();

    expect(statuses.at(-1)).toMatchObject({
      role: "reader",
      error: "[not_found] View v1 does not belong to this window",
    });
  });

  describe("key bindings", () => {
    const key = (code: string, modifiers: Partial<KeyEvent> = {}): KeyEvent => ({
      type: "keydown",
      key: code.startsWith("Key") ? code.slice(3) : code,
      code,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      isComposing: false,
      preventDefault: () => {},
      ...modifiers,
    });

    it("runs a bound key as command before xterm.js sees it and keeps it from the shell", () => {
      const api = new FakeApi();
      const surface = new FakeSurface();
      const commands: string[] = [];
      new TerminalController(api, surface, () => {}, {
        commands: { applies: () => true, run: (command) => commands.push(command) },
      });

      const forTerminal = surface.pressKey(key("KeyD", { ctrlKey: true, shiftKey: true }));

      expect(forTerminal).toBe(false);
      expect(commands).toEqual(["splitRow"]);
    });

    it("lets xterm.js process a bound key whose command has nothing to do (Alt+Left in a single pane)", () => {
      const api = new FakeApi();
      const surface = new FakeSurface();
      const commands: string[] = [];
      new TerminalController(api, surface, () => {}, {
        commands: { applies: () => false, run: (command) => commands.push(command) },
      });

      expect(surface.pressKey(key("ArrowLeft", { altKey: true }))).toBe(true);

      expect(commands).toEqual([]);
    });

    it("passes Ctrl+C, Ctrl+B and letters on to the shell", () => {
      const api = new FakeApi();
      const surface = new FakeSurface();
      const commands: string[] = [];
      new TerminalController(api, surface, () => {}, {
        commands: { applies: () => true, run: (command) => commands.push(command) },
      });

      expect(surface.pressKey(key("KeyC", { ctrlKey: true }))).toBe(true);
      expect(surface.pressKey(key("KeyB", { ctrlKey: true }))).toBe(true);
      expect(surface.pressKey(key("KeyA"))).toBe(true);

      expect(commands).toEqual([]);
    });
  });

  it("switches bracketed paste on after the reset when the session runs in tmux, and only then", async () => {
    const withTmux = new FakeSurface();
    const apiA = new FakeApi();
    const a = new TerminalController(apiA, withTmux, () => {}, { bracketedPaste: true });
    const openingA = a.open("s1");
    apiA.answerAttach({ writerViewId: "v1" });
    await openingA;
    const without = new FakeSurface();
    const apiB = new FakeApi();
    const b = new TerminalController(apiB, without, () => {});
    const openingB = b.open("s1");
    apiB.answerAttach({ writerViewId: "v1" });
    await openingB;

    expect(withTmux.screen).toEqual(["<reset>", "\x1b[?2004h", "snap"]);
    expect(without.screen).toEqual(["<reset>", "snap"]);
  });

  describe("clipboard", () => {
    it("as writer pastes through the terminal, so line breaks and bracketed paste follow the application", async () => {
      const { api, surface, controller } = await opened({ writerViewId: "v1" });

      expect(controller.paste("Grüße\nzweite Zeile")).toBe(true);
      surface.bracketedPaste = true;
      expect(controller.paste("a\r\nb")).toBe(true);

      expect(api.inputs).toEqual([
        ["v1", "Grüße\rzweite Zeile"],
        ["v1", "\x1b[200~a\rb\x1b[201~"],
      ]);
    });

    it("as reader refuses to paste and sends nothing", async () => {
      const { api, controller } = await opened({ writerViewId: "v0" });

      expect(controller.canPaste()).toBe(false);
      expect(controller.paste("text")).toBe(false);

      expect(api.inputs).toEqual([]);
    });

    it("does not paste before the view is attached", () => {
      const api = new FakeApi();
      const controller = new TerminalController(api, new FakeSurface(), () => {});
      void controller.open("s1");

      expect(controller.paste("text")).toBe(false);

      expect(api.inputs).toEqual([]);
    });

    it("does not paste an empty text or after the core is gone", async () => {
      const { api, controller } = await opened({ writerViewId: "v1" });

      expect(controller.paste("")).toBe(false);
      api.emit({ kind: "coreClosed" });
      expect(controller.paste("text")).toBe(false);

      expect(api.inputs).toEqual([]);
    });

    it("hands out the selection, also as reader", async () => {
      const { surface, controller } = await opened({ writerViewId: "v0" });
      surface.selection = "Umlaute äöü\nzweite Zeile";

      expect(controller.selectedText()).toBe("Umlaute äöü\nzweite Zeile");
    });

    it("becomes able to paste when it takes the writer", async () => {
      const { api, controller } = await opened({ writerViewId: "v0" });

      expect(controller.canPaste()).toBe(false);
      api.emit({ kind: "writerChanged", sessionId: "s1", writerViewId: "v1" });

      expect(controller.canPaste()).toBe(true);
      expect(controller.paste("x")).toBe(true);
    });
  });

  it("detaches its view and stops listening on dispose", async () => {
    const { api, surface, controller } = await opened({ writerViewId: "v1" });

    await controller.dispose();
    surface.emitData("x");
    api.output("s1", 1, "late");

    expect(api.detached).toEqual(["v1"]);
    expect(api.inputs).toEqual([]);
    expect(surface.screen).not.toContain("late");
    expect(api.listeners.size).toBe(0);
  });
});

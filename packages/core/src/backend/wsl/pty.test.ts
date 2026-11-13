import { describe, expect, it } from "vitest";
import { WslPty, type PtyProcess } from "./pty.js";

class FakeProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizes: [number, number][] = [];
  killed = false;
  private dataListener: ((data: string) => void) | undefined;
  private exitListener: ((event: { exitCode: number }) => void) | undefined;

  write(data: string | Buffer): void {
    this.writes.push(typeof data === "string" ? data : data.toString("utf8"));
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(): void {
    this.killed = true;
  }
  onData(listener: (data: string) => void) {
    this.dataListener = listener;
    return { dispose: () => (this.dataListener = undefined) };
  }
  onExit(listener: (event: { exitCode: number }) => void) {
    this.exitListener = listener;
    return { dispose: () => (this.exitListener = undefined) };
  }
  emitData(data: string): void {
    this.dataListener?.(data);
  }
  emitExit(): void {
    this.exitListener?.({ exitCode: 0 });
  }
}

const decoder = new TextDecoder();
const DA1_REPLY = "\x1b[?1;2c";

function setup(resolveEnd: () => Promise<{ exitCode?: number }> = async () => ({})) {
  const process = new FakeProcess();
  const pty = new WslPty(process, resolveEnd);
  const output: string[] = [];
  pty.onData((data) => output.push(decoder.decode(data)));
  const exits: { exitCode?: number }[] = [];
  pty.onExit((event) => exits.push(event));
  return { process, pty, output, exits };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("WslPty", () => {
  it("answers the first DA1 query itself and removes it from the output", () => {
    const { process, output } = setup();
    process.emitData("\x1b[cprompt$ ");
    expect(process.writes).toEqual([DA1_REPLY]);
    expect(output).toEqual(["prompt$ "]);
  });

  it("also answers the ESC [ 0 c form, but only once", () => {
    const { process, output } = setup();
    process.emitData("a\x1b[0cb");
    process.emitData("\x1b[c");
    expect(process.writes).toEqual([DA1_REPLY]);
    expect(output).toEqual(["ab", "\x1b[c"]);
  });

  it("still answers when only typed input came first (it would otherwise wait 3 s)", () => {
    const { process, pty, output } = setup();
    pty.write("echo hi\r");
    process.emitData("\x1b[1t");
    process.emitData("\x1b[c\x1b[?1004h");
    expect(process.writes).toEqual(["echo hi\r", DA1_REPLY]);
    expect(output).toEqual(["\x1b[1t", "\x1b[?1004h"]);
  });

  it("leaves DA1 to the view once a DA1 answer came from outside", () => {
    const { process, pty, output } = setup();
    pty.write(new TextEncoder().encode("\x1b[?62;22c"));
    process.emitData("\x1b[c");
    expect(process.writes).toEqual(["\x1b[?62;22c"]);
    expect(output).toEqual(["\x1b[c"]);
  });

  it("passes input as text or bytes and forwards resizes", () => {
    const { process, pty } = setup();
    pty.write("ls\r");
    pty.write(new TextEncoder().encode("ä"));
    pty.resize({ cols: 100, rows: 30 });
    expect(process.writes).toEqual(["ls\r", "ä"]);
    expect(process.resizes).toEqual([[100, 30]]);
  });

  it("reports the end with what the backend resolves, once", async () => {
    const { process, exits } = setup(async () => ({ exitCode: 7 }));
    process.emitExit();
    process.emitExit();
    await tick();
    expect(exits).toEqual([{ exitCode: 7 }]);
  });

  it("reports the end without exit code when resolving fails", async () => {
    const { process, exits } = setup(async () => {
      throw new Error("wsl.exe failed");
    });
    process.emitExit();
    await tick();
    expect(exits).toEqual([{}]);
  });

  it("dispose ends only the client, reports nothing and ignores later calls", async () => {
    let resolved = 0;
    const { process, pty, output, exits } = setup(async () => {
      resolved += 1;
      return {};
    });
    pty.dispose();
    expect(process.killed).toBe(true);
    process.emitData("late");
    process.emitExit();
    await tick();
    pty.write("x");
    pty.resize({ cols: 1, rows: 1 });
    pty.dispose();
    expect(output).toEqual([]);
    expect(exits).toEqual([]);
    expect(resolved).toBe(0);
    expect(process.writes).toEqual([]);
  });

  it("does not report an end that was being resolved when dispose came", async () => {
    let finish: (value: { exitCode?: number }) => void = () => {};
    const { process, pty, exits } = setup(() => new Promise((resolve) => (finish = resolve)));
    process.emitExit();
    pty.dispose();
    finish({ exitCode: 1 });
    await tick();
    expect(exits).toEqual([]);
  });
});

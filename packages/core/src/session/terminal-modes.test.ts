import { describe, expect, it } from "vitest";
import { TerminalModes } from "./terminal-modes.js";

const encoder = new TextEncoder();

function after(...chunks: string[]): string {
  const modes = new TerminalModes();
  for (const chunk of chunks) modes.feed(encoder.encode(chunk));
  return modes.sequence();
}

describe("TerminalModes", () => {
  it("is empty without output and for output without modes", () => {
    expect(after()).toBe("");
    expect(after("hello \x1b[1;31mred\x1b[0m \x1b[2J\x1b[H\x1b]0;title\x07")).toBe("");
  });

  it("restores the modes tmux 3.6 sets at its client, in a fixed order", () => {
    // Start of a tmux client behind the ConPTY, then `set -g mouse on` (measured, design.md).
    const start =
      "\x1b[?1004h\x1b[?9001h\x1b[?1049h\x1b[?1h\x1b=\x1b[?12l\x1b[?25h" +
      "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1005l\x1b[?2004h\x1b[?2031h";
    const mouse = "\x1b[?1006l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006h\x1b[?1000h\x1b[?1002h";

    expect(after(start, mouse)).toBe("\x1b[?1h\x1b=\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[?2004h");
  });

  it("follows switching off", () => {
    expect(after("\x1b[?1h\x1b=\x1b[?1004h\x1b[?2004h", "\x1b[?1l\x1b>\x1b[?1004l\x1b[?2004l")).toBe("");
  });

  it("reads several parameters in one sequence and the keypad as mode 66", () => {
    expect(after("\x1b[?1;66;2004h")).toBe("\x1b[?1h\x1b=\x1b[?2004h");
    expect(after("\x1b=", "\x1b[?66l")).toBe("");
  });

  it("keeps the last mouse protocol; resetting any protocol switches tracking off", () => {
    expect(after("\x1b[?1000h\x1b[?1003h")).toBe("\x1b[?1003h");
    expect(after("\x1b[?9h")).toBe("\x1b[?9h");
    expect(after("\x1b[?1002h\x1b[?1000l")).toBe("");
  });

  it("keeps the last mouse encoding; resetting an encoding falls back to the default", () => {
    expect(after("\x1b[?1000h\x1b[?1006h\x1b[?1016h")).toBe("\x1b[?1000h\x1b[?1016h");
    expect(after("\x1b[?1015h", "\x1b[?1006h\x1b[?1006l")).toBe("");
  });

  it("joins a sequence split over chunks, also right after ESC", () => {
    expect(after("\x1b[?20", "04h")).toBe("\x1b[?2004h");
    expect(after("text \x1b", "=")).toBe("\x1b=");
    expect(after("\x1b", "[", "?", "1", "h")).toBe("\x1b[?1h");
  });

  it("resets everything on RIS and all but the mouse on DECSTR", () => {
    const on = "\x1b[?1h\x1b=\x1b[?1000h\x1b[?1006h\x1b[?1004h\x1b[?2004h";
    expect(after(on, "\x1bc")).toBe("");
    expect(after(on, "\x1b[!p")).toBe("\x1b[?1000h\x1b[?1006h");
  });

  it("ignores modes it does not restore and sequences that are not private modes", () => {
    expect(after("\x1b[?1049h\x1b[?25l\x1b[?9001h\x1b[?2031h\x1b[4h\x1b[>4;1m\x1b[2 q")).toBe("");
  });

  it("drops an unfinished sequence that grows over its limit and goes on after it", () => {
    expect(after(`\x1b[?${"1".repeat(100)}`, "h\x1b[?2004h")).toBe("\x1b[?2004h");
  });

  it("starts over when ESC interrupts a sequence", () => {
    expect(after("\x1b[?20\x1b[?1h")).toBe("\x1b[?1h");
  });

  it("forgets everything on reset", () => {
    const modes = new TerminalModes();
    modes.feed(encoder.encode("\x1b[?2004h\x1b[?20"));
    modes.reset();
    modes.feed(encoder.encode("04h"));
    expect(modes.sequence()).toBe("");
  });
});

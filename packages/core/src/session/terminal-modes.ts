// Terminal modes a session's output has switched on, for the snapshot of a late view (issue #42, ADR 0003).
// tmux sets the modes of its client once (DECCKM, keypad, bracketed paste) or on `set -g mouse on`; a view that
// attaches later never sees those bytes. The registry feeds every output chunk here and puts `sequence()` in
// front of the snapshot. Only sequences from the fixed list below are produced, never bytes of the output.

const ESC = 0x1b;
/** An unfinished control sequence longer than this is dropped, so the state stays bounded. */
const MAX_SEQUENCE_BYTES = 64;
const MOUSE_PROTOCOLS = new Set([9, 1000, 1002, 1003]);
const MOUSE_ENCODINGS = new Set([1005, 1006, 1015, 1016]);

type ParserState = "ground" | "escape" | "csi";

interface Modes {
  /** DECCKM, `CSI ? 1 h`: cursor keys send `ESC O A` instead of `ESC [ A`. */
  cursorKeys: boolean;
  /** Application keypad, `ESC =` or `CSI ? 66 h`. */
  keypad: boolean;
  /** Mouse tracking protocol (9, 1000, 1002, 1003), 0 when off. */
  mouseProtocol: number;
  /** Mouse report encoding (1005, 1006, 1015, 1016), 0 for the default. */
  mouseEncoding: number;
  /** Focus reports, `CSI ? 1004 h`. */
  focus: boolean;
  /** Bracketed paste, `CSI ? 2004 h`. */
  bracketedPaste: boolean;
}

function initialModes(): Modes {
  return {
    cursorKeys: false,
    keypad: false,
    mouseProtocol: 0,
    mouseEncoding: 0,
    focus: false,
    bracketedPaste: false,
  };
}

export class TerminalModes {
  private modes = initialModes();
  private state: ParserState = "ground";
  /** Parameters and intermediates of the control sequence being read. */
  private sequenceBody = "";

  /** Reads one chunk of output; a sequence may continue in the next chunk. */
  feed(data: Uint8Array): void {
    for (const byte of data) this.step(byte);
  }

  /** Back to the state of a fresh terminal (restart, archive). */
  reset(): void {
    this.modes = initialModes();
    this.state = "ground";
    this.sequenceBody = "";
  }

  /**
   * Sequences that bring a terminal from its initial state into the current modes, in a fixed order; empty
   * when all modes are off.
   */
  sequence(): string {
    const { cursorKeys, keypad, mouseProtocol, mouseEncoding, focus, bracketedPaste } = this.modes;
    let out = "";
    if (cursorKeys) out += "\x1b[?1h";
    if (keypad) out += "\x1b=";
    if (mouseProtocol !== 0) out += `\x1b[?${mouseProtocol}h`;
    if (mouseEncoding !== 0) out += `\x1b[?${mouseEncoding}h`;
    if (focus) out += "\x1b[?1004h";
    if (bracketedPaste) out += "\x1b[?2004h";
    return out;
  }

  private step(byte: number): void {
    if (byte === ESC) {
      this.state = "escape";
      this.sequenceBody = "";
      return;
    }
    switch (this.state) {
      case "ground":
        return;
      case "escape":
        this.state = "ground";
        if (byte === 0x5b /* [ */) this.state = "csi";
        else if (byte === 0x3d /* = */) this.modes.keypad = true;
        else if (byte === 0x3e /* > */) this.modes.keypad = false;
        else if (byte === 0x63 /* c, RIS */) this.modes = initialModes();
        return;
      case "csi":
        if (byte >= 0x40 && byte <= 0x7e) {
          this.state = "ground";
          this.controlSequence(this.sequenceBody, String.fromCharCode(byte));
          this.sequenceBody = "";
          return;
        }
        if (this.sequenceBody.length >= MAX_SEQUENCE_BYTES) {
          this.state = "ground";
          this.sequenceBody = "";
          return;
        }
        this.sequenceBody += String.fromCharCode(byte);
        return;
    }
  }

  private controlSequence(body: string, final: string): void {
    if (body === "!" && final === "p") {
      // DECSTR (soft reset) leaves the mouse alone, like xterm.js.
      this.modes = {
        ...initialModes(),
        mouseProtocol: this.modes.mouseProtocol,
        mouseEncoding: this.modes.mouseEncoding,
      };
      return;
    }
    if ((final !== "h" && final !== "l") || !/^\?[\d;]*$/.test(body)) return;
    const on = final === "h";
    for (const param of body.slice(1).split(";")) {
      if (param !== "") this.privateMode(Number(param), on);
    }
  }

  private privateMode(mode: number, on: boolean): void {
    const modes = this.modes;
    if (mode === 1) modes.cursorKeys = on;
    else if (mode === 66) modes.keypad = on;
    else if (mode === 1004) modes.focus = on;
    else if (mode === 2004) modes.bracketedPaste = on;
    // Resetting any protocol or encoding falls back to none or the default, as in xterm.js.
    else if (MOUSE_PROTOCOLS.has(mode)) modes.mouseProtocol = on ? mode : 0;
    else if (MOUSE_ENCODINGS.has(mode)) modes.mouseEncoding = on ? mode : 0;
  }
}

import { IpcError } from "@termdock/core";
import { describe, expect, it } from "vitest";
import type { BridgeEvent } from "../shared/bridge.js";
import { QuitPrompt } from "./quit-prompt.js";

function setup(known: (windowId: number) => boolean = () => true) {
  const sent: [number, BridgeEvent][] = [];
  let next = 0;
  const prompt = new QuitPrompt(
    (windowId, event) => {
      sent.push([windowId, event]);
      return known(windowId);
    },
    () => `q${(next += 1)}`,
  );
  return { prompt, sent };
}

describe("QuitPrompt", () => {
  it("asks the window and resolves with its answer", async () => {
    const { prompt, sent } = setup();
    const answer = prompt.ask(7, 3);
    expect(sent).toEqual([[7, { kind: "quitRequested", requestId: "q1", activeSessions: 3 }]]);
    prompt.answer(7, "q1", { choice: "stopSessions", remember: true });
    await expect(answer).resolves.toEqual({ choice: "stopSessions", remember: true });
  });

  it("gives a second ask the answer of the open question without a second dialog", async () => {
    const { prompt, sent } = setup();
    const first = prompt.ask(7, 3);
    const second = prompt.ask(8, 3);
    expect(sent).toHaveLength(1);
    prompt.answer(7, "q1", { choice: "keepSessions", remember: false });
    await expect(second).resolves.toEqual(await first);
  });

  it("refuses an answer from another window, with a wrong id, or without a question", async () => {
    const { prompt } = setup();
    expect(() => prompt.answer(7, "q1", { choice: "cancel", remember: false })).toThrow(IpcError);
    const answer = prompt.ask(7, 1);
    expect(() => prompt.answer(8, "q1", { choice: "keepSessions", remember: false })).toThrow(IpcError);
    expect(() => prompt.answer(7, "other", { choice: "keepSessions", remember: false })).toThrow(IpcError);
    prompt.answer(7, "q1", { choice: "cancel", remember: false });
    await expect(answer).resolves.toEqual({ choice: "cancel", remember: false });
    expect(() => prompt.answer(7, "q1", { choice: "cancel", remember: false })).toThrow(IpcError);
  });

  it("cancels at once when the window cannot be reached", async () => {
    const { prompt } = setup(() => false);
    await expect(prompt.ask(7, 1)).resolves.toEqual({ choice: "cancel", remember: false });
  });

  it("sends the open question again when the page of its window has loaded", async () => {
    const { prompt, sent } = setup();
    const answer = prompt.ask(7, 2);
    prompt.resend(8);
    expect(sent).toHaveLength(1);
    prompt.resend(7);
    expect(sent).toEqual([
      [7, { kind: "quitRequested", requestId: "q1", activeSessions: 2 }],
      [7, { kind: "quitRequested", requestId: "q1", activeSessions: 2 }],
    ]);
    prompt.answer(7, "q1", { choice: "keepSessions", remember: false });
    await answer;
    prompt.resend(7);
    expect(sent).toHaveLength(2);
  });

  it("cancels when the asked window is gone, and ignores other windows", async () => {
    const { prompt } = setup();
    const answer = prompt.ask(7, 1);
    prompt.windowGone(8);
    prompt.windowGone(7);
    await expect(answer).resolves.toEqual({ choice: "cancel", remember: false });
    // A new question is possible afterwards.
    const again = prompt.ask(9, 1);
    prompt.answer(9, "q2", { choice: "keepSessions", remember: false });
    await expect(again).resolves.toEqual({ choice: "keepSessions", remember: false });
  });
});

import { IpcError } from "@termdock/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BridgeEvent } from "../shared/bridge.js";
import { QUIT_ASK_ACK_TIMEOUT_MS, QUIT_ASK_RETRY_MS, QuitPrompt } from "./quit-prompt.js";

afterEach(() => vi.useRealTimers());

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

const KEEP = { choice: "keepSessions", remember: false } as const;
const CANCELLED = { choice: "cancel", remember: false } as const;

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
    prompt.answer(7, "q1", KEEP);
    await expect(second).resolves.toEqual(await first);
  });

  it("refuses an answer from another window, with a wrong id, or without a question", async () => {
    const { prompt } = setup();
    expect(() => prompt.answer(7, "q1", CANCELLED)).toThrow(IpcError);
    const answer = prompt.ask(7, 1);
    expect(() => prompt.answer(8, "q1", KEEP)).toThrow(IpcError);
    expect(() => prompt.answer(7, "other", KEEP)).toThrow(IpcError);
    prompt.answer(7, "q1", CANCELLED);
    await expect(answer).resolves.toEqual(CANCELLED);
    expect(() => prompt.answer(7, "q1", CANCELLED)).toThrow(IpcError);
  });

  it("cancels at once when the window cannot be reached", async () => {
    const { prompt } = setup(() => false);
    await expect(prompt.ask(7, 1)).resolves.toEqual(CANCELLED);
  });

  it("cancels when the asked window is gone, and ignores other windows", async () => {
    const { prompt } = setup();
    const answer = prompt.ask(7, 1);
    prompt.windowGone(8);
    prompt.windowGone(7);
    await expect(answer).resolves.toEqual(CANCELLED);
    // A new question is possible afterwards.
    const again = prompt.ask(9, 1);
    prompt.answer(9, "q2", KEEP);
    await expect(again).resolves.toEqual(KEEP);
  });

  describe("delivery", () => {
    it("sends the question again until the window confirms, and not after", async () => {
      vi.useFakeTimers();
      const { prompt, sent } = setup();
      const answer = prompt.ask(7, 2);
      expect(sent).toHaveLength(1);
      vi.advanceTimersByTime(QUIT_ASK_RETRY_MS * 2);
      expect(sent).toHaveLength(3);
      expect(new Set(sent.map(([, event]) => JSON.stringify(event))).size).toBe(1);
      prompt.ack(7, "q1");
      vi.advanceTimersByTime(QUIT_ASK_ACK_TIMEOUT_MS * 3);
      expect(sent).toHaveLength(3);
      prompt.answer(7, "q1", KEEP);
      await expect(answer).resolves.toEqual(KEEP);
    });

    it("sends the open question again when the page of its window has loaded", () => {
      const { prompt, sent } = setup();
      void prompt.ask(7, 2);
      prompt.resend(8);
      expect(sent).toHaveLength(1);
      prompt.resend(7);
      expect(sent).toHaveLength(2);
      prompt.windowGone(7);
      prompt.resend(7);
      expect(sent).toHaveLength(2);
    });

    it("cancels when the window never confirms (its renderer did not listen)", async () => {
      vi.useFakeTimers();
      const { prompt } = setup();
      const answer = prompt.ask(7, 1);
      vi.advanceTimersByTime(QUIT_ASK_ACK_TIMEOUT_MS);
      await expect(answer).resolves.toEqual(CANCELLED);
      // The slot is free again: the next quit asks anew.
      const again = prompt.ask(7, 1);
      prompt.answer(7, "q2", KEEP);
      await expect(again).resolves.toEqual(KEEP);
    });

    it("waits without a limit once the dialog is shown", async () => {
      vi.useFakeTimers();
      const { prompt } = setup();
      let settled = false;
      const answer = prompt.ask(7, 1).then((value) => {
        settled = true;
        return value;
      });
      prompt.ack(7, "q1");
      vi.advanceTimersByTime(QUIT_ASK_ACK_TIMEOUT_MS * 10);
      await Promise.resolve();
      expect(settled).toBe(false);
      prompt.answer(7, "q1", KEEP);
      await expect(answer).resolves.toEqual(KEEP);
    });

    it("refuses a confirmation from another window or for another question", () => {
      const { prompt } = setup();
      void prompt.ask(7, 1);
      expect(() => prompt.ack(8, "q1")).toThrow(IpcError);
      expect(() => prompt.ack(7, "other")).toThrow(IpcError);
      prompt.windowGone(7);
      expect(() => prompt.ack(7, "q1")).toThrow(IpcError);
    });
  });
});

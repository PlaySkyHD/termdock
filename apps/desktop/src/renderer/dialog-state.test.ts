import { describe, expect, it } from "vitest";
import { closeIfCurrent, failureText } from "./dialog-state.js";

describe("failureText", () => {
  it("drops the code of the preload and keeps the message of the core", () => {
    expect(failureText(new Error("[invalid_state] Session s1 is running"))).toBe("Session s1 is running");
  });

  it("keeps a message without a code and shows non-errors as text", () => {
    expect(failureText(new Error("kaputt"))).toBe("kaputt");
    expect(failureText("nope")).toBe("nope");
  });
});

describe("closeIfCurrent", () => {
  const own = { title: "a" };
  const other = { title: "b" };

  it("closes the dialog that finished", () => {
    expect(closeIfCurrent(own, own)).toBeUndefined();
  });

  it("leaves a dialog the user opened meanwhile, and none at all", () => {
    expect(closeIfCurrent(other, own)).toBe(other);
    expect(closeIfCurrent(undefined, own)).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import { defaultPipeName, sanitizePipeUser } from "./pipe-name.js";

describe("pipe name", () => {
  it("builds the per-user pipe path from a readable user part and a short hash", () => {
    expect(defaultPipeName("nic", "PC")).toMatch(/^\\\\\.\\pipe\\termdock-core-nic-[0-9a-f]{12}$/);
  });

  it("is stable for the same account", () => {
    expect(defaultPipeName("nic", "PC")).toBe(defaultPipeName("nic", "PC"));
  });

  it("separates accounts whose cleaned names are equal", () => {
    expect(defaultPipeName("Jörg", "PC")).not.toBe(defaultPipeName("Jürg", "PC"));
    expect(defaultPipeName("bob", "DOMAIN")).not.toBe(defaultPipeName("bob", "PC"));
    expect(defaultPipeName("a b", "PC")).not.toBe(defaultPipeName("a_b", "PC"));
  });

  it("replaces characters that are not allowed in a pipe name", () => {
    expect(sanitizePipeUser("DOMAIN\\Max Mustermann")).toBe("DOMAIN_Max_Mustermann");
    expect(sanitizePipeUser("a/b:c*d")).toBe("a_b_c_d");
  });

  it("never yields an empty user part", () => {
    expect(sanitizePipeUser("")).toBe("user");
    expect(defaultPipeName("", "PC")).toMatch(/termdock-core-user-[0-9a-f]{12}$/);
  });

  it("uses the current OS account when none is given", () => {
    expect(defaultPipeName()).toMatch(/^\\\\\.\\pipe\\termdock-core-[A-Za-z0-9_.-]+-[0-9a-f]{12}$/);
  });
});

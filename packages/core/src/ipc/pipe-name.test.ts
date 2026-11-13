import { describe, expect, it } from "vitest";
import { defaultPipeName, sanitizePipeUser } from "./pipe-name.js";

describe("pipe name", () => {
  it("builds the per-user pipe path from the user name", () => {
    expect(defaultPipeName("nic")).toBe("\\\\.\\pipe\\termdock-core-nic");
  });

  it("replaces characters that are not allowed in a pipe name", () => {
    expect(sanitizePipeUser("DOMAIN\\Max Mustermann")).toBe("DOMAIN_Max_Mustermann");
    expect(sanitizePipeUser("a/b:c*d")).toBe("a_b_c_d");
  });

  it("never yields an empty user part", () => {
    expect(sanitizePipeUser("")).toBe("user");
    expect(defaultPipeName("")).toBe("\\\\.\\pipe\\termdock-core-user");
  });

  it("uses the current OS user when none is given", () => {
    expect(defaultPipeName()).toMatch(/^\\\\\.\\pipe\\termdock-core-[A-Za-z0-9_.-]+$/);
  });
});

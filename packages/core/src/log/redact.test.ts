import { describe, expect, it } from "vitest";
import { redact, REDACTED } from "./redact.js";

// Invented values only: no real token of any project.
const GITHUB_TOKEN = `ghp_${"x".repeat(36)}`;
const GITHUB_PAT = `github_pat_${"x".repeat(30)}`;
const API_KEY = `sk-${"x".repeat(32)}`;
const SLACK = `xoxb-${"1".repeat(12)}-${"x".repeat(12)}`;
const NO_ENV = {};

describe("redact", () => {
  it("replaces the value of an env variable whose name contains a secret word", () => {
    for (const name of ["API_TOKEN", "DB_SECRET", "MY_PASSWORD", "SSH_KEY", "PROXY_AUTH"]) {
      expect(redact(`env ${name}=hunter2-invented rest`, NO_ENV)).toBe(`env ${name}=${REDACTED} rest`);
    }
  });

  it("handles quoted values and JSON members", () => {
    expect(redact(`API_TOKEN="two words"`, NO_ENV)).toBe(`API_TOKEN=${REDACTED}`);
    expect(redact(`{"API_TOKEN": "abc123def"}`, NO_ENV)).toBe(`{"API_TOKEN": ${REDACTED}}`);
  });

  it("replaces the value of a secret env variable wherever it appears", () => {
    const env = { MY_TOKEN: "invented-value-1234", SHORT_KEY: "abc", PATH: "invented-path-value" };
    expect(redact("failed with invented-value-1234 in url", env)).toBe(`failed with ${REDACTED} in url`);
    // Too short to search for, and not a secret name.
    expect(redact("abc invented-path-value", env)).toBe("abc invented-path-value");
  });

  it("replaces the whole Authorization header line", () => {
    expect(redact("sent Authorization: Bearer abc.def.ghi to host", NO_ENV)).toBe(
      `sent Authorization: ${REDACTED}`,
    );
    expect(redact("authorization: Basic Zm9vOmJhcg==\nnext line", NO_ENV)).toBe(
      `authorization: ${REDACTED}\nnext line`,
    );
  });

  it("replaces token shapes", () => {
    for (const secret of [GITHUB_TOKEN, GITHUB_PAT, API_KEY, SLACK]) {
      expect(redact(`clone https://${secret}@example.invalid/x`, NO_ENV)).toBe(
        `clone https://${REDACTED}@example.invalid/x`,
      );
    }
  });

  it("redacts lower-case names with a whole secret word but not words that only contain one", () => {
    expect(redact("api_key=abc123 Password: hunter2", NO_ENV)).toBe(
      `api_key=${REDACTED} Password: ${REDACTED}`,
    );
    const text = "keyboard: de author=x monkey=1 hotkey: Ctrl+K";
    expect(redact(text, NO_ENV)).toBe(text);
  });

  it("leaves ordinary text alone", () => {
    const text =
      "could not save session 3f2a: ENOENT, path C:\\Users\\dev\\termdock PATH=/usr/bin skip-this sk-short";
    expect(redact(text, { HOME: "/home/dev", PATH: "/usr/bin" })).toBe(text);
  });
});

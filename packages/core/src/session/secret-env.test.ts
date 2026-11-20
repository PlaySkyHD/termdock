import { describe, expect, it } from "vitest";
import { assertNoSecretEnv, secretEnvFinding, secretEnvKey } from "./secret-env.js";

const FAKE = "td-test-secret-0000";

describe("secret env rule (issue #149)", () => {
  it("finds the key names that end in a secret word", () => {
    for (const key of [
      "GITHUB_TOKEN",
      "DB_PASSWORD",
      "GITHUB_PAT",
      "github_pat",
      "DB_PASS",
      "STRIPE_KEY",
      "stripe_key",
      "AWS_ACCESS_KEY",
      "APIKEY",
    ]) {
      expect(secretEnvKey({ [key]: FAKE }), key).toBe(key);
    }
  });

  it("finds a URL with a password in the value, whatever the key", () => {
    for (const value of [
      `postgres://app:${FAKE}@db.example.invalid/x`,
      `redis://:${FAKE}@cache.example.invalid`,
      `https://user:${FAKE}@example.invalid/repo.git`,
    ]) {
      expect(secretEnvFinding({ DATABASE_URL: value })).toEqual({
        key: "DATABASE_URL",
        reason: "url-password",
      });
    }
  });

  it("keeps common harmless entries", () => {
    const harmless = {
      KEYBOARD: "us",
      KEYMAP: "de",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      PATH: "/usr/bin:/bin",
      XDG_RUNTIME_DIR: "/run/user/1000",
      XDG_DATA_DIRS: "/usr/share",
      LANG: "C.UTF-8",
      TOKENS_PER_MIN: "100",
      BYPASS: "1",
      PATTERN: "x",
      GPG_PUBLIC_KEY: "ABCD",
      DATABASE_URL: "postgres://db.example.invalid:5432/x",
      REPO_URL: "https://example.invalid/a@b",
      SSH_URL: "ssh://git@example.invalid/repo.git",
      PROXY: "http://proxy.example.invalid:8080",
    };
    expect(secretEnvFinding(harmless)).toBeUndefined();
    expect(secretEnvFinding(undefined)).toBeUndefined();
  });

  it("names the key and never the value in the refusal", () => {
    for (const env of [{ STRIPE_KEY: FAKE }, { DATABASE_URL: `postgres://u:${FAKE}@h/x` }]) {
      let message = "";
      try {
        assertNoSecretEnv(env, "profile");
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain(Object.keys(env)[0]!);
      expect(message).not.toContain(FAKE);
    }
  });
});

// Env entries that obviously hold a secret (security.instructions.md): neither a launch profile nor a stored session
// keeps them in plain text. Credentials come from the CLI login or a protected environment variable.
import { CoreError } from "./errors.js";

/**
 * Names ending in TOKEN, SECRET, PASSWORD, PASSWD, API_KEY, SECRET_KEY, ACCESS_KEY, PRIVATE_KEY or CREDENTIAL(S),
 * any case; and names whose last part after an underscore is PAT or PASS (`GITHUB_PAT`, `DB_PASS`). A bare `_KEY`
 * is no rule: `SORT_KEY`, `CACHE_KEY` and `SSH_KEY` (a path) are harmless. The underscore keeps `KEYBOARD`,
 * `KEYMAP`, `SSH_AUTH_SOCK` and a plain `PATH` out.
 */
const SECRET_ENV_KEY =
  /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|SECRET_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|_PAT|_PASS)$/i;
/** A public key is no secret. */
const PUBLIC_KEY = /PUBLIC_?KEY$/i;
/** A URL with a password in its userinfo: `scheme://user:password@host` (the user may be empty). */
const URL_WITH_PASSWORD = /[a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:[^\s/@]+@/i;

export interface SecretEnvFinding {
  key: string;
  /** `name`: the key names a secret; `url-password`: the value is a URL with a password. */
  reason: "name" | "url-password";
}

/** True when the key alone names a secret. */
export function isSecretEnvKey(key: string): boolean {
  return SECRET_ENV_KEY.test(key) && !PUBLIC_KEY.test(key);
}

/** The reason why the entry holds a secret, or undefined. Never includes the value. */
export function secretEnvReason(key: string, value: string): SecretEnvFinding["reason"] | undefined {
  if (isSecretEnvKey(key)) return "name";
  if (URL_WITH_PASSWORD.test(value)) return "url-password";
  return undefined;
}

/** The first entry of `env` that holds a secret, or undefined. */
export function secretEnvFinding(
  env: Readonly<Record<string, string>> | undefined,
): SecretEnvFinding | undefined {
  for (const [key, value] of Object.entries(env ?? {})) {
    const reason = secretEnvReason(key, String(value));
    if (reason !== undefined) return { key, reason };
  }
  return undefined;
}

/** The first key of `env` that holds a secret, or undefined. */
export function secretEnvKey(env: Readonly<Record<string, string>> | undefined): string | undefined {
  return secretEnvFinding(env)?.key;
}

/** Throws `bad_request` naming the key (never the value) when `env` has an entry that holds a secret. */
export function assertNoSecretEnv(
  env: Readonly<Record<string, string>> | undefined,
  owner: "profile" | "session",
): void {
  const finding = secretEnvFinding(env);
  if (finding === undefined) return;
  const what =
    finding.reason === "name" ? "looks like a secret" : "holds a URL with a password, which is a secret";
  throw new CoreError(
    "bad_request",
    `launch.env key "${finding.key.slice(0, 64)}" ${what}; credentials come from the CLI login or a protected environment variable, not from a ${owner}`,
  );
}

// Env names that obviously hold a secret (security.instructions.md): neither a launch profile nor a stored session
// keeps them in plain text. Credentials come from the CLI login or a protected environment variable.
import { CoreError } from "./errors.js";

/** Names ending in TOKEN, SECRET, PASSWORD, PASSWD, API_KEY, ACCESS_KEY, PRIVATE_KEY or CREDENTIAL(S), any case. */
const SECRET_ENV_KEY = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?)$/i;

/** The first key of `env` that names a secret, or undefined. */
export function secretEnvKey(env: Readonly<Record<string, string>> | undefined): string | undefined {
  return Object.keys(env ?? {}).find((key) => SECRET_ENV_KEY.test(key));
}

/** Throws `bad_request` naming the key (never the value) when `env` has a key that names a secret. */
export function assertNoSecretEnv(
  env: Readonly<Record<string, string>> | undefined,
  owner: "profile" | "session",
): void {
  const key = secretEnvKey(env);
  if (key === undefined) return;
  throw new CoreError(
    "bad_request",
    `launch.env key "${key.slice(0, 64)}" looks like a secret; credentials come from the CLI login or a protected environment variable, not from a ${owner}`,
  );
}

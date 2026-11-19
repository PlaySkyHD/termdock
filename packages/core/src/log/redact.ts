// Redaction of known secret shapes before a log line is written (spec diagnostics). The filter is shared by the
// core and the desktop app; it only replaces text, it never interprets it.

export const REDACTED = "«redacted»";

/** Env names whose values are secrets: the name contains one of these words (any case). */
const SECRET_NAME_WORDS = ["TOKEN", "SECRET", "PASSWORD", "KEY", "AUTH"] as const;
const SECRET_NAME = new RegExp(SECRET_NAME_WORDS.join("|"), "i");
/** Shorter values would hit ordinary text ("1", "true") when they are searched for. */
const MIN_ENV_VALUE_LENGTH = 6;

/** Token shapes that identify themselves; each match is replaced as a whole. */
const TOKEN_SHAPES: readonly RegExp[] = [
  /ghp_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[a-z]-[A-Za-z0-9-]{10,}/g,
];

/** `Authorization: <anything up to the end of the line>`; the scheme goes with it. */
const AUTHORIZATION = /(\bauthorization["']?\s*[:=]\s*)[^\r\n]*/gi;

const VALUE = `("[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s"',;}\\])]+)`;
const WORDS = SECRET_NAME_WORDS.join("|");

/**
 * `NAME=value`, `NAME: value` or `"NAME": "value"` where NAME is an env-style name (upper case) that contains a
 * secret word anywhere, or a name of other case where the secret word is a whole part (`api_key`, `Password`, but
 * not `keyboard`, `author` or `hotkey`).
 */
const ASSIGNMENTS: readonly RegExp[] = [
  new RegExp(`(\\b[A-Z0-9_]*(?:${WORDS})[A-Z0-9_]*(["']?)\\s*[=:]\\s*)${VALUE}`, "g"),
  new RegExp(
    `((?<![A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:${WORDS})(?:[_-][A-Za-z0-9]+)*(?![A-Za-z0-9])(["']?)\\s*[=:]\\s*)${VALUE}`,
    "gi",
  ),
];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Values of the env variables with a secret name that are long enough to be searched for. */
function secretValues(env: Readonly<Record<string, string | undefined>>): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value.length >= MIN_ENV_VALUE_LENGTH && SECRET_NAME.test(name)) {
      values.add(value);
    }
  }
  // Longest first: a value that contains another is replaced as a whole.
  return [...values].sort((a, b) => b.length - a.length);
}

/**
 * Replaces known secret shapes in `text` with `«redacted»`: values of env variables whose name contains TOKEN, SECRET,
 * PASSWORD, KEY or AUTH (found by `NAME=value` and by the value of the given `env`), `Authorization: …` headers
 * and tokens of the shapes `ghp_…`, `github_pat_…`, `sk-…` and `xox…`.
 */
export function redact(
  text: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  let result = text;
  for (const value of secretValues(env))
    result = result.replace(new RegExp(escapeRegExp(value), "g"), REDACTED);
  result = result.replace(AUTHORIZATION, (_match, head: string) => `${head}${REDACTED}`);
  for (const assignment of ASSIGNMENTS) {
    result = result.replace(assignment, (_match, head: string) => `${head}${REDACTED}`);
  }
  for (const shape of TOKEN_SHAPES) result = result.replace(shape, REDACTED);
  return result;
}

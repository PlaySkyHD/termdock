// Checks docs/acceptance.md against the V1 acceptance criteria (docs/concept/v1-konzept.txt, section 10) and the
// code (issue #132). Runs in CI; tests: scripts/acceptance-check.test.mjs (`npm run test:hooks`).
//
// Usage: node scripts/acceptance-check.mjs [--root <dir>]     (default: the repository this script lives in)
//
// The rules:
// - Every criterion of the concept has a section `### V1-<nn>: <text>` with the text of the concept, a line
//   `Status: <status>` and a row `| <nn> | <text> | <status> |` in the overview table.
// - A criterion without proof must be `offen, #<issue>`; every other criterion has at least one proof.
// - `- Test `<file>`: `<name>``: the file exists and holds the name as a string literal; the name carries
//   `[V1-<nn>]` of its section.
// - `- Szene `<file>` (Gruppe `<group>`): `<picture>.png``: the file exists and holds the picture name in quotes.
// - `- Manuell: <step>`: a step that cannot be automated.
// - Every test in packages/ and apps/ whose name starts with `[V1-<nn>]` is listed under each of its criteria.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DOC = "docs/acceptance.md";
const CONCEPT = "docs/concept/v1-konzept.txt";
const STATUSES = ["automatisiert", "automatisiert und manuell", "manuell"];
const OPEN = /^offen, #\d+$/;
const SCAN_DIRS = ["packages", "apps"];
const SKIP_DIRS = new Set(["node_modules", "dist", "release", "out"]);
const TEST_FILE = /\.test\.(ts|tsx|mjs)$/;
// `it("[V1-01] ...")`, `test.skip('[V1-01][V1-02] ...')`, also with the name on the next line (Prettier).
// The name may hold the other quotes ("the writer's size").
const PREFIXED_TEST = /\b(?:it|test)(?:\.\w+)*\(\s*(["'`])(\[V1-\d\d\](?:(?!\1)[^\\\n])*)\1/g;

/** The criteria of section 10 of the concept: number ("01") to text. */
export function readCriteria(text) {
  const criteria = new Map();
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^10\.\s+V1-Abnahmekriterien/.test(line)) {
      inside = true;
      continue;
    }
    if (!inside) continue;
    // Criteria count up from 01; the next numbered line that is not the next criterion is the next section
    // ("11. Technische Risiken" after criterion 15, while "11. Das Speicherlimit" is criterion 11).
    const match = /^(\d+)\.\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    const expected = String(criteria.size + 1).padStart(2, "0");
    if (match[1] !== expected) break;
    criteria.set(match[1], match[2]);
  }
  return criteria;
}

/** Overview rows and sections of docs/acceptance.md, each with its line number. */
export function parseDoc(text) {
  const rows = new Map();
  const sections = [];
  let current;
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    const lineNo = index + 1;
    const heading = /^### V1-(\d\d):\s*(.+)$/.exec(line);
    if (heading) {
      current = {
        number: heading[1],
        text: heading[2],
        line: lineNo,
        status: undefined,
        proofs: [],
        bad: [],
      };
      sections.push(current);
      return;
    }
    if (/^#{1,3} /.test(line)) {
      current = undefined;
      return;
    }
    const row = /^\|\s*(\d\d)\s*\|(.*)\|\s*([^|]*?)\s*\|$/.exec(line);
    if (row && current === undefined) {
      rows.set(row[1], { text: row[2].trim(), status: row[3], line: lineNo });
      return;
    }
    if (current === undefined) return;
    const status = /^Status:\s*(.+)$/.exec(line);
    if (status) {
      current.status = status[1];
      return;
    }
    if (!line.startsWith("- ")) return;
    const test = /^- Test `([^`]+)`: `([^`]+)`$/.exec(line);
    const scene = /^- Szene `([^`]+)`(?: \(Gruppe `[^`]+`\))?: `([^`]+\.png)`$/.exec(line);
    const manual = /^- Manuell: (\S.*)$/.exec(line);
    if (test) current.proofs.push({ kind: "test", file: test[1], name: test[2], line: lineNo });
    else if (scene) current.proofs.push({ kind: "scene", file: scene[1], name: scene[2], line: lineNo });
    else if (manual) current.proofs.push({ kind: "manual", name: manual[1], line: lineNo });
    else current.bad.push(lineNo);
  });
  return { rows, sections };
}

function isQuoted(content, name) {
  return ['"', "'", "`"].some((quote) => content.includes(`${quote}${name}${quote}`));
}

function* testFiles(root, dir) {
  const full = join(root, dir);
  if (!existsSync(full)) return;
  for (const entry of readdirSync(full, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* testFiles(root, path);
    } else if (TEST_FILE.test(entry.name)) yield path.split(sep).join("/");
  }
}

/** Tests whose name starts with `[V1-<nn>]`: file, name and the numbers of the prefix. */
export function findPrefixedTests(root) {
  const found = [];
  for (const dir of SCAN_DIRS) {
    for (const file of testFiles(root, dir)) {
      const content = readFileSync(join(root, file), "utf8");
      for (const match of content.matchAll(PREFIXED_TEST)) {
        const name = match[2];
        const numbers = [...name.matchAll(/\[V1-(\d\d)\]/g)].map((each) => each[1]);
        found.push({ file, name, numbers });
      }
    }
  }
  return found;
}

/** All errors of the acceptance overview below `root`; empty when it is complete. */
export function checkAcceptance(root) {
  const errors = [];
  const at = (line, message) => errors.push(`${DOC}:${line}: ${message}`);
  const conceptPath = join(root, CONCEPT);
  const docPath = join(root, DOC);
  if (!existsSync(conceptPath)) return [`${CONCEPT}: missing`];
  if (!existsSync(docPath)) return [`${DOC}: missing`];
  const criteria = readCriteria(readFileSync(conceptPath, "utf8"));
  if (criteria.size === 0) return [`${CONCEPT}: no criteria found in section 10`];
  const { rows, sections } = parseDoc(readFileSync(docPath, "utf8"));
  const byNumber = new Map();

  for (const section of sections) {
    if (!criteria.has(section.number)) {
      at(section.line, `V1-${section.number} is no criterion of the concept`);
      continue;
    }
    if (byNumber.has(section.number)) {
      at(section.line, `V1-${section.number} appears twice`);
      continue;
    }
    byNumber.set(section.number, section);
  }

  for (const [number, text] of criteria) {
    const section = byNumber.get(number);
    const row = rows.get(number);
    if (section === undefined) {
      errors.push(`${DOC}: V1-${number} has no section "### V1-${number}: ${text}"`);
      continue;
    }
    if (section.text !== text) at(section.line, `V1-${number}: text differs from the concept ("${text}")`);
    for (const line of section.bad) at(line, `V1-${number}: unknown proof format`);
    const status = section.status;
    if (status === undefined) at(section.line, `V1-${number}: no "Status:" line`);
    else if (!STATUSES.includes(status) && !OPEN.test(status))
      at(section.line, `V1-${number}: unknown status "${status}"`);
    if (row === undefined) errors.push(`${DOC}: V1-${number} has no row in the overview table`);
    else {
      if (row.text !== text) at(row.line, `V1-${number}: text in the table differs from the concept`);
      if (status !== undefined && row.status !== status)
        at(row.line, `V1-${number}: status in the table ("${row.status}") differs from the section`);
    }

    const tests = section.proofs.filter((proof) => proof.kind !== "manual");
    const manual = section.proofs.filter((proof) => proof.kind === "manual");
    if (status !== undefined && OPEN.test(status)) {
      if (section.proofs.length > 0) at(section.line, `V1-${number}: status is open but proofs are listed`);
    } else if (section.proofs.length === 0) at(section.line, `V1-${number}: no proof`);
    else if (status === "automatisiert" && tests.length === 0)
      at(section.line, `V1-${number}: "automatisiert" needs a test or a scene`);
    else if (status === "manuell" && tests.length > 0)
      at(section.line, `V1-${number}: "manuell" lists tests; use "automatisiert und manuell"`);
    else if (status === "automatisiert und manuell" && (tests.length === 0 || manual.length === 0))
      at(section.line, `V1-${number}: "automatisiert und manuell" needs a test and a manual step`);
    else if (status === "automatisiert" && manual.length > 0)
      at(section.line, `V1-${number}: "automatisiert" lists a manual step; use "automatisiert und manuell"`);

    for (const proof of tests) {
      const full = resolve(root, proof.file);
      if (relative(root, full).startsWith("..") || !existsSync(full) || !statSync(full).isFile()) {
        at(proof.line, `${proof.file} does not exist`);
        continue;
      }
      const content = readFileSync(full, "utf8");
      if (proof.kind === "test") {
        if (!proof.name.includes(`[V1-${number}]`)) at(proof.line, `"${proof.name}" lacks [V1-${number}]`);
        if (!isQuoted(content, proof.name)) at(proof.line, `no test "${proof.name}" in ${proof.file}`);
      } else if (!isQuoted(content, proof.name)) at(proof.line, `no scene "${proof.name}" in ${proof.file}`);
    }
  }

  for (const test of findPrefixedTests(root)) {
    for (const number of test.numbers) {
      const section = byNumber.get(number);
      if (!criteria.has(number)) errors.push(`${test.file}: "${test.name}": V1-${number} is no criterion`);
      else if (
        section !== undefined &&
        !section.proofs.some(
          (proof) => proof.kind === "test" && proof.file === test.file && proof.name === test.name,
        )
      )
        errors.push(`${test.file}: "${test.name}" is not listed under V1-${number} in ${DOC}`);
    }
  }
  return errors;
}

function main(argv) {
  let root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root" && argv[i + 1] !== undefined) root = resolve(argv[(i += 1)]);
    else {
      console.error("usage: node scripts/acceptance-check.mjs [--root <dir>]");
      return 2;
    }
  }
  const errors = checkAcceptance(root);
  if (errors.length > 0) {
    for (const error of errors) console.error(error);
    console.error(`acceptance-check: ${errors.length} error(s)`);
    return 1;
  }
  const { sections } = parseDoc(readFileSync(join(root, DOC), "utf8"));
  const proofs = sections.reduce((sum, section) => sum + section.proofs.length, 0);
  console.log(`acceptance-check: ${sections.length} criteria, ${proofs} proofs ok`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

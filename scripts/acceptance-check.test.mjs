// Tests for scripts/acceptance-check.mjs (issue #132). Run with `npm run test:hooks`.
// Each test builds a small repository in a temp folder: concept, docs/acceptance.md and test files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL, fileURLToPath } from "node:url";
import { checkAcceptance, readCriteria } from "./acceptance-check.mjs";

const script = fileURLToPath(new URL("./acceptance-check.mjs", import.meta.url));

const CONCEPT = [
  "9. Vorher",
  "",
  "10. V1-Abnahmekriterien",
  "",
  "01. Erstes Kriterium.",
  "02. Zweites Kriterium.",
  "03. Drittes Kriterium.",
  "",
  "11. Technische Risiken",
  "01. Kein Kriterium.",
].join("\n");

const TESTS = {
  "packages/core/src/a.test.ts": [
    'it("[V1-01] does the first thing", () => {});',
    "it(",
    '  "[V1-02] does the second thing, with the writer\'s size",',
    "  () => {},",
    ");",
    'it("is no proof", () => {});',
  ].join("\n"),
  "apps/desktop/src/main/screenshot-x.ts": 'await capture("10-picture.png");',
};

function doc({ rows, sections }) {
  return [
    "# V1-Abnahme",
    "",
    "## Übersicht",
    "",
    "| Nr  | Kriterium | Status |",
    "| --- | --------- | ------ |",
    ...rows,
    "",
    "## Kriterien",
    "",
    ...sections,
  ].join("\n");
}

const VALID = doc({
  rows: [
    "| 01  | Erstes Kriterium.  | automatisiert |",
    "| 02  | Zweites Kriterium. | automatisiert und manuell |",
    "| 03  | Drittes Kriterium. | offen, #65 |",
  ],
  sections: [
    "### V1-01: Erstes Kriterium.",
    "",
    "Status: automatisiert",
    "",
    "- Test `packages/core/src/a.test.ts`: `[V1-01] does the first thing`",
    "- Szene `apps/desktop/src/main/screenshot-x.ts` (Gruppe `x`): `10-picture.png`",
    "",
    "### V1-02: Zweites Kriterium.",
    "",
    "Status: automatisiert und manuell",
    "",
    "- Test `packages/core/src/a.test.ts`: `[V1-02] does the second thing, with the writer's size`",
    "- Manuell: Fenster öffnen und schauen.",
    "",
    "### V1-03: Drittes Kriterium.",
    "",
    "Status: offen, #65",
  ],
});

function withRepo({ docText = VALID, tests = TESTS, concept = CONCEPT } = {}, body) {
  const root = mkdtempSync(join(tmpdir(), "acceptance-test-"));
  try {
    const files = { "docs/concept/v1-konzept.txt": concept, ...tests };
    if (docText !== null) files["docs/acceptance.md"] = docText;
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const errorsFor = (options) => withRepo(options, (root) => checkAcceptance(root));

test("reads the criteria of section 10 and stops at section 11", () => {
  assert.deepEqual(
    [...readCriteria(CONCEPT)],
    [
      ["01", "Erstes Kriterium."],
      ["02", "Zweites Kriterium."],
      ["03", "Drittes Kriterium."],
    ],
  );
});

test("accepts a complete overview, with exit code 0 on the command line", () => {
  assert.deepEqual(errorsFor(), []);
  withRepo({}, (root) => {
    const result = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /3 criteria, 4 proofs ok/);
  });
});

test("fails on the command line with exit code 1 and names the error", () => {
  withRepo({ docText: VALID.replace("### V1-03: Drittes Kriterium.", "") }, (root) => {
    const result = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /V1-03 has no section/);
  });
});

test("refuses an unknown argument with exit code 2", () => {
  const result = spawnSync(process.execPath, [script, "--nope"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage/);
});

test("reports a missing overview", () => {
  assert.deepEqual(errorsFor({ docText: null }), ["docs/acceptance.md: missing"]);
});

test("reports a criterion without proof that is not open", () => {
  const docText = VALID.replace(
    "- Test `packages/core/src/a.test.ts`: `[V1-01] does the first thing`\n",
    "",
  ).replace("- Szene `apps/desktop/src/main/screenshot-x.ts` (Gruppe `x`): `10-picture.png`\n", "");
  // Without its prefix the test would also be missing from the overview; that is another test.
  const code = TESTS["packages/core/src/a.test.ts"].replace("[V1-01] ", "");
  const errors = errorsFor({ docText, tests: { ...TESTS, "packages/core/src/a.test.ts": code } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /V1-01: no proof/);
});

test("reports an open criterion that lists proofs, and an unknown status", () => {
  const errors = errorsFor({
    docText: VALID.replace("Status: offen, #65", "Status: offen, #65\n\n- Manuell: x")
      .replace("| 01  | Erstes Kriterium.  | automatisiert |", "| 01  | Erstes Kriterium.  | fertig |")
      .replace("Status: automatisiert\n", "Status: fertig\n"),
  });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /V1-01: unknown status "fertig"/);
  assert.match(errors[1], /V1-03: status is open but proofs are listed/);
});

test("reports a test name that is not in the code", () => {
  const errors = errorsFor({
    docText: VALID.replace("`[V1-01] does the first thing`", "`[V1-01] does the frist thing`"),
  });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /no test "\[V1-01\] does the frist thing" in packages\/core\/src\/a\.test\.ts/);
  // The real test is no longer listed under its criterion.
  assert.match(errors[1], /"\[V1-01\] does the first thing" is not listed under V1-01/);
});

test("reports a listed test without the prefix of its criterion", () => {
  const errors = errorsFor({
    docText: VALID.replace(
      "- Test `packages/core/src/a.test.ts`: `[V1-01] does the first thing`",
      "- Test `packages/core/src/a.test.ts`: `[V1-01] does the first thing`\n- Test `packages/core/src/a.test.ts`: `is no proof`",
    ),
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /"is no proof" lacks \[V1-01\]/);
});

test("reports a missing file and a scene that the file does not take", () => {
  const errors = errorsFor({
    docText: VALID.replace(
      "`packages/core/src/a.test.ts`: `[V1-02]",
      "`packages/core/src/gone.test.ts`: `[V1-02]",
    ).replace("`10-picture.png`", "`11-other.png`"),
  });
  assert.equal(errors.length, 3);
  assert.match(errors[0], /11-other\.png/);
  assert.match(errors[1], /gone\.test\.ts does not exist/);
  assert.match(errors[2], /is not listed under V1-02/);
});

test("reports a prefixed test in the code that the overview does not list", () => {
  const errors = errorsFor({
    tests: {
      ...TESTS,
      "apps/desktop/src/b.test.ts":
        "it('[V1-01] does more', () => {});\nit(`[V1-09] is no criterion`, () => {});",
    },
  });
  assert.deepEqual(errors, [
    'apps/desktop/src/b.test.ts: "[V1-01] does more" is not listed under V1-01 in docs/acceptance.md',
    'apps/desktop/src/b.test.ts: "[V1-09] is no criterion": V1-09 is no criterion',
  ]);
});

test("reports a text or status that differs from the concept or the section", () => {
  const errors = errorsFor({
    docText: VALID.replace("### V1-02: Zweites Kriterium.", "### V1-02: Zweites Kriterium").replace(
      "| 03  | Drittes Kriterium. | offen, #65 |",
      "| 03  | Drittes Kriterium. | manuell |",
    ),
  });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /V1-02: text differs from the concept/);
  assert.match(errors[1], /V1-03: status in the table \("manuell"\) differs from the section/);
});

test("wants a test and a manual step for 'automatisiert und manuell', and no manual step for 'automatisiert'", () => {
  const errors = errorsFor({
    docText: VALID.replace("- Manuell: Fenster öffnen und schauen.", "").replace(
      "Status: automatisiert\n\n",
      "Status: automatisiert\n\n- Manuell: auch noch\n",
    ),
  });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /V1-01: "automatisiert" lists a manual step/);
  assert.match(errors[1], /V1-02: "automatisiert und manuell" needs a test and a manual step/);
});

test("reports a list item in an unknown format and a criterion that appears twice", () => {
  const errors = errorsFor({
    docText: `${VALID.replace("- Manuell: Fenster öffnen und schauen.", "- Manuell: Fenster öffnen und schauen.\n- Siehe oben")}\n\n### V1-03: Drittes Kriterium.\n\nStatus: offen, #65\n`,
  });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /V1-03 appears twice/);
  assert.match(errors[1], /V1-02: unknown proof format/);
});

// Tests for scripts/create-issues.sh with a fake `gh` (GH=<script>): it never talks to GitHub, so no real issue is
// created. Run with `npm run test:hooks`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL, fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./create-issues.sh", import.meta.url));

// Numbers issues from 101, keeps every call in calls.log and every text in create-<n>.md / edit-<n>.md.
// FAKE_GH_FAIL_ON=<n> makes the n-th `issue create` fail.
const FAKE_GH = `#!/usr/bin/env bash
dir="$FAKE_GH_DIR"
echo "$*" >> "$dir/calls.log"
body=""
prev=""
for arg in "$@"; do
  [[ "$prev" == "--body-file" ]] && body="$arg"
  prev="$arg"
done
if [[ "$1 $2" == "issue create" ]]; then
  n=$(( $(cat "$dir/counter" 2>/dev/null || echo 100) + 1 ))
  if [[ "\${FAKE_GH_FAIL_ON:-}" == "$((n - 100))" ]]; then echo "boom" >&2; exit 1; fi
  echo "$n" > "$dir/counter"
  cp "$body" "$dir/create-$n.md"
  echo "https://github.com/example/repo/issues/$n"
elif [[ "$1 $2" == "issue edit" ]]; then
  cp "$body" "$dir/edit-$3.md"
else
  echo "unexpected gh call: $*" >&2
  exit 1
fi
`;

function setup(plan, texts) {
  const root = mkdtempSync(join(tmpdir(), "create-issues-test-"));
  const folder = join(root, "plan");
  const fake = join(root, "fake");
  for (const dir of [folder, fake]) spawnSync("mkdir", ["-p", dir]);
  writeFileSync(join(folder, "plan.txt"), plan);
  for (const [key, text] of Object.entries(texts)) writeFileSync(join(folder, `${key}.md`), text);
  const gh = join(fake, "gh");
  writeFileSync(gh, FAKE_GH, { mode: 0o755 });
  const run = (args, env = {}) =>
    spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        GH: gh.replaceAll("\\", "/"),
        FAKE_GH_DIR: fake.replaceAll("\\", "/"),
        ...env,
      },
    });
  const read = (name) => readFileSync(join(fake, name), "utf8");
  const calls = () => (existsSync(join(fake, "calls.log")) ? read("calls.log").trim().split("\n") : []);
  return {
    root,
    folder,
    fake,
    run,
    read,
    calls,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("replaces placeholders with the new numbers and fills in forward references in a second pass", () => {
  const t = setup(
    "# comment\n\nA|agent-retro|Erstes Issue\nB|agent-retro,bug|Zweites | mit Strich\nC||Drittes\n",
    {
      A: "Siehe #{{B}} und #{{B}} sowie #{{C}}.\n",
      B: "Hängt von #{{A}} ab, nicht von sich selbst.\n",
      C: "Verweist auf #{{C}} und #{{A}}.\n",
    },
  );
  try {
    const result = t.run([t.folder]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(t.read("create-101.md"), "Siehe #{{B}} und #{{B}} sowie #{{C}}.\n");
    assert.equal(t.read("create-102.md"), "Hängt von #101 ab, nicht von sich selbst.\n");
    assert.equal(t.read("create-103.md"), "Verweist auf #{{C}} und #101.\n");
    assert.equal(t.read("edit-101.md"), "Siehe #102 und #102 sowie #103.\n");
    assert.equal(t.read("edit-103.md"), "Verweist auf #103 und #101.\n");
    assert.equal(existsSync(join(t.fake, "edit-102.md")), false);
    assert.equal(readFileSync(join(t.folder, "numbers.txt"), "utf8"), "A|101\nB|102\nC|103\n");
    const calls = t.calls();
    assert.equal(calls.length, 5);
    assert.match(calls[0], /^issue create --title Erstes Issue --body-file \S+ --label agent-retro$/);
    assert.match(calls[1], /--title Zweites \| mit Strich .*--label agent-retro --label bug$/);
    assert.doesNotMatch(calls[2], /--label/);
  } finally {
    t.cleanup();
  }
});

test("a plan without forward references needs no second pass", () => {
  const t = setup("A|x|Eins\nB|x|Zwei\n", { A: "Nichts.\n", B: "Nach #{{A}}.\n" });
  try {
    const result = t.run([t.folder]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(t.read("create-102.md"), "Nach #101.\n");
    assert.equal(t.calls().length, 2);
  } finally {
    t.cleanup();
  }
});

test("an open placeholder stops the run before any issue is created", () => {
  const t = setup("A|x|Eins\nB|x|Zwei\n", { A: "Nichts.\n", B: "Nach #{{tippfehler}}.\n" });
  try {
    const result = t.run([t.folder]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /open placeholder \{\{tippfehler\}\} in .*B\.md/);
    assert.deepEqual(t.calls(), []);
    assert.equal(existsSync(join(t.folder, "numbers.txt")), false);
  } finally {
    t.cleanup();
  }
});

test("an unbalanced brace pair stops the run before any issue is created", () => {
  const t = setup("A|x|Eins\n", { A: "Nach #{{A}.\n" });
  try {
    const result = t.run([t.folder]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /broken placeholder/);
    assert.deepEqual(t.calls(), []);
  } finally {
    t.cleanup();
  }
});

test("a plan with a missing text, a double key, a bad key or a placeholder in a title is refused", () => {
  const cases = [
    ["A|x|Eins\nB|x|Zwei\n", { A: "a\n" }, /missing text .*B\.md/],
    ["A|x|Eins\nA|x|Zwei\n", { A: "a\n" }, /key 'A' is used twice/],
    ["a b|x|Eins\n", { "a b": "a\n" }, /bad key 'a b'/],
    ["A|x|Eins {{A}}\n", { A: "a\n" }, /no placeholders in titles/],
    ["A|x|\n", { A: "a\n" }, /empty title/],
    ["A x Eins\n", { A: "a\n" }, /expected <key>\|<labels>\|<title>/],
    ["# nur Kommentar\n", {}, /no issues/],
  ];
  for (const [plan, texts, message] of cases) {
    const t = setup(plan, texts);
    try {
      const result = t.run([t.folder]);
      assert.equal(result.status, 2, plan);
      assert.match(result.stderr, message, plan);
      assert.deepEqual(t.calls(), [], plan);
    } finally {
      t.cleanup();
    }
  }
});

test("dry run checks the plan, lists the issues and never calls gh", () => {
  const t = setup("A|agent-retro|Erstes\nB||Zweites\n", { A: "Nach #{{B}}.\n", B: "Nach #{{A}}.\n" });
  try {
    const result = t.run(["--dry-run", t.folder], { GH: "/nonexistent/gh-must-not-run" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dry run: 2 issues/);
    assert.match(
      result.stdout,
      /- A \[agent-retro\] Erstes\n\s+refers to: B\n\s+forward references \(second pass\): B/,
    );
    assert.match(result.stdout, /- B \[\] Zweites\n\s+refers to: A\n/);
    assert.deepEqual(t.calls(), []);
    assert.equal(existsSync(join(t.folder, "numbers.txt")), false);
  } finally {
    t.cleanup();
  }
});

test("dry run still stops on an open placeholder", () => {
  const t = setup("A|x|Eins\n", { A: "Nach #{{B}}.\n" });
  try {
    const result = t.run(["--dry-run", t.folder]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /open placeholder \{\{B\}\}/);
  } finally {
    t.cleanup();
  }
});

test("a folder with numbers.txt is refused", () => {
  const t = setup("A|x|Eins\n", { A: "a\n" });
  try {
    writeFileSync(join(t.folder, "numbers.txt"), "A|7\n");
    const result = t.run([t.folder]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /numbers\.txt exists/);
    assert.deepEqual(t.calls(), []);
  } finally {
    t.cleanup();
  }
});

test("a failing gh call stops the run and numbers.txt lists what exists", () => {
  const t = setup("A|x|Eins\nB|x|Zwei\nC|x|Drei\n", { A: "a\n", B: "b\n", C: "c\n" });
  try {
    const result = t.run([t.folder], { FAKE_GH_FAIL_ON: "2" });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(t.folder, "numbers.txt"), "utf8"), "A|101\n");
    assert.equal(t.calls().length, 2);
  } finally {
    t.cleanup();
  }
});

test("wrong arguments exit with 2", () => {
  const t = setup("A|x|Eins\n", { A: "a\n" });
  try {
    assert.equal(t.run([]).status, 2);
    assert.equal(t.run([join(t.root, "missing")]).status, 2);
    assert.equal(t.run(["--dry-run"]).status, 2);
  } finally {
    t.cleanup();
  }
});

test("a plan with Windows line ends works", () => {
  const t = setup("A|x|Eins\r\nB|x|Zwei\r\n", { A: "a\n", B: "Nach #{{A}}.\n" });
  try {
    const result = t.run([t.folder]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(t.read("create-102.md"), "Nach #101.\n");
    assert.match(t.calls()[0], /--title Eins /);
  } finally {
    t.cleanup();
  }
});

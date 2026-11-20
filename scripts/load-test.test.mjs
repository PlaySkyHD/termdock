// Tests for the pure parts of scripts/load-test.mjs (issue #134). Run with `npm run test:hooks`; the load test
// itself needs WSL and runs only by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS,
  LIMITS,
  evaluate,
  formatTable,
  killServerArgs,
  loadTestSocket,
  noisyCommand,
  parseArgs,
  percentile,
} from "./load-test.mjs";

test("defaults to 50 sessions, 10 of them noisy", () => {
  assert.deepEqual(parseArgs([]), { ...DEFAULTS });
  assert.equal(DEFAULTS.sessions, 50);
  assert.equal(DEFAULTS.noisy, 10);
});

test("parses options and rejects bad values", () => {
  const options = parseArgs(["--sessions", "5", "--noisy", "2", "--settle-ms", "0", "--json", "out.json"]);
  assert.equal(options.sessions, 5);
  assert.equal(options.noisy, 2);
  assert.equal(options.settleMs, 0);
  assert.equal(options.json, "out.json");
  assert.throws(() => parseArgs(["--sessions", "x"]), /whole number/);
  assert.throws(() => parseArgs(["--bogus", "1"]), /unknown option/);
  assert.throws(() => parseArgs(["--sessions", "3", "--noisy", "3"]), /quiet session/);
  assert.throws(() => parseArgs(["--sessions", "1"]), /at least 2/);
});

test("percentile uses the nearest rank", () => {
  assert.equal(percentile([], 95), undefined);
  assert.equal(percentile([5], 95), 5);
  const values = Array.from({ length: 20 }, (_, i) => 20 - i);
  assert.equal(percentile(values, 50), 10);
  assert.equal(percentile(values, 95), 19);
  assert.equal(percentile(values, 100), 20);
});

test("evaluate compares each value with the limits of issue #134", () => {
  assert.deepEqual(LIMITS, { reconcileMs: 3000, rssMiB: 300, echoP95Ms: 100 });
  const checks = evaluate({ reconcileMs: 2999, rssMiB: 300, echo: { p95Ms: 12 } });
  assert.deepEqual(
    checks.map((check) => [check.name, check.ok]),
    [
      ["reconcile", true],
      ["rss", false],
      ["echo p95", true],
    ],
  );
  assert.equal(evaluate({ reconcileMs: 1, rssMiB: 1 })[2].ok, false);
  const table = formatTable(
    { sessions: 50, noisy: 10, startMs: 1, restartReadyMs: 2, echo: { p50Ms: 1, maxMs: 3 } },
    checks,
  );
  assert.match(table, /rss\s+300 MiB\s+< 300 MiB OVER/);
});

test("the socket follows the run scheme of the WSL tests and is never the production one", () => {
  const socket = loadTestSocket(1234);
  assert.match(socket, /^termdock-test-1234-[0-9a-f]{8}$/);
  assert.notEqual(loadTestSocket(), loadTestSocket());
});

test("kill-server only targets a run socket, never termdock or termdock-test", () => {
  const socket = loadTestSocket(1234);
  assert.deepEqual(killServerArgs(socket, "Ubuntu"), [
    "-d",
    "Ubuntu",
    "--cd",
    "~",
    "--exec",
    "tmux",
    "-L",
    socket,
    "kill-server",
  ]);
  assert.deepEqual(killServerArgs(socket).slice(0, 2), ["--cd", "~"]);
  for (const bad of [
    "termdock",
    "termdock-test",
    "termdock-test-1234",
    "termdock-test-x-ab",
    "termdock-test-1-ab;x",
    "",
    undefined,
  ]) {
    assert.throws(() => killServerArgs(bad, "Ubuntu"), /refusing kill-server/);
  }
});

test("the noisy program is an argument array with a throttled loop", () => {
  assert.deepEqual(noisyCommand(200), ["sh", "-c", "while :; do yes | head -n 200; sleep 0.1; done"]);
  assert.throws(() => noisyCommand(0));
  assert.throws(() => noisyCommand("1; rm -rf /"));
});

// Tests for the pure parts of scripts/pty-shutdown-repro.mjs (issue #160). Run with `npm run test:hooks`; the
// reproduction itself needs Windows and runs only by hand.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hex, parseArgs } from "./pty-shutdown-repro.mjs";

test("defaults to 50 runs with 20 PTYs through the core's dispose path", () => {
  assert.deepEqual(parseArgs([]), { runs: 50, ptys: 20, mode: "dispose", parallel: 1, child: false });
});

test("reads runs, PTYs, mode, parallel runs and the child flag", () => {
  assert.deepEqual(
    parseArgs(["--runs", "3", "--ptys", "5", "--mode", "kill", "--parallel", "2", "--child"]),
    {
      runs: 3,
      ptys: 5,
      mode: "kill",
      parallel: 2,
      child: true,
    },
  );
});

test("rejects unknown options, unknown modes and values that are no positive integers", () => {
  assert.throws(() => parseArgs(["--sessions", "3"]), /unknown option/);
  assert.throws(() => parseArgs(["--mode", "all"]), /--mode must be one of/);
  assert.throws(() => parseArgs(["--runs", "0"]), /positive integer/);
  assert.throws(() => parseArgs(["--ptys"]), /needs a value/);
});

test("shows a crash as NTSTATUS in hex and other codes as they are", () => {
  assert.equal(hex(3221225477), "0xC0000005");
  assert.equal(hex(-1073741819), "0xC0000005");
  assert.equal(hex(0), "0");
  assert.equal(hex(2), "2");
  assert.equal(hex(null), "null");
});

// A core for the hard-kill test (issue #133), run as its own process from `dist/test/flooding-core.js`. Like
// `termdock-core`, but with a FakeBackend whose sessions print without pause, so the history is being written when
// the test ends the process. TERMDOCK_PIPE and TERMDOCK_DATA_DIR isolate it. Not part of the app.
import { FakeBackend } from "../backend/fake.js";
import { runCore } from "../bin/run-core.js";

/** Lines each session prints per tick; every line names its number, so the test can check what it reads back. */
const LINES_PER_TICK = 64;

const pipePath = process.env["TERMDOCK_PIPE"];
const dataDir = process.env["TERMDOCK_DATA_DIR"];
if (!pipePath || !dataDir) {
  process.stderr.write("flooding-core: TERMDOCK_PIPE and TERMDOCK_DATA_DIR are required\n");
  process.exit(2);
}

const backend = new FakeBackend();
backend.onPty = (pty) => {
  let line = 0;
  const timer = setInterval(() => {
    if (pty.disposed || pty.ended) {
      clearInterval(timer);
      return;
    }
    let text = "";
    for (let i = 0; i < LINES_PER_TICK; i++) text += `flood ${String(++line).padStart(8, "0")}\r\n`;
    pty.emitData(text);
  }, 1);
};

const result = await runCore({
  pipePath,
  dataDir,
  backends: [backend],
  onExit: (code) => process.exit(code),
});
if (result.exitCode !== 0) process.exit(result.exitCode);

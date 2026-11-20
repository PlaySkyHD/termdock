// Security test (issue #135, spec session-lifecycle "Terminal-Ausgabe ist Daten"): escape sequences in the output
// of a session pass through the core byte for byte. The core neither answers them on the PTY nor acts on them;
// only the terminal emulator of a view interprets them.
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeBackend } from "../backend/fake.js";
import { runCore } from "../bin/run-core.js";
import { connect } from "../ipc/client.js";
import type { CoreClient } from "../ipc/client.js";
import { readHistory } from "../storage/history-store.js";

/** OSC 52 (write the clipboard), OSC 8 (link), OSC 0/2 (title), each with BEL or ST, around plain text. */
const HOSTILE_OUTPUT =
  "before\r\n" +
  `\x1b]52;c;${Buffer.from("td-test clipboard").toString("base64")}\x07` +
  "\x1b]8;;https://example.invalid/td-test\x1b\\link text\x1b]8;;\x1b\\\r\n" +
  "\x1b]0;td-test title\x07\x1b]2;td-test window\x1b\\" +
  // OSC 52 query: a terminal that answered it would send the clipboard back as input.
  "\x1b]52;c;?\x07" +
  "after\r\n";

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function uniquePipe(): string {
  const name = `termdock-test-${randomUUID()}`;
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : join(tmpdir(), `${name}.sock`);
}

describe("terminal output is data (issue #135)", () => {
  it("passes OSC 52, OSC 8 and title sequences through unchanged and answers none of them", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "termdock-osc-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const pipePath = uniquePipe();
    const backend = new FakeBackend();
    const stderr: string[] = [];
    const core = await runCore({
      pipePath,
      dataDir,
      backends: [backend],
      installSignalHandlers: false,
      stderr: { write: (text: string) => void stderr.push(text) },
    });
    cleanups.push(() => core.close?.());
    const client: CoreClient = await connect(pipePath, { requestTimeoutMs: 5000 });
    cleanups.push(() => client.close());

    const launch = { backend: "wsl", cwd: "/home/dev" } as const;
    const { session } = (await client.request("session.create", { name: "osc", launch })).result;
    await client.request("session.attach", { sessionId: session.id });
    const received: Uint8Array[] = [];
    client.on("session.output", (_data, payload) => received.push(payload));
    const pty = backend.pty(session.id);
    const bytes = new TextEncoder().encode(HOSTILE_OUTPUT);
    pty.emitData(bytes);
    // A plain marker behind it: once it has arrived, everything before it has been handled.
    pty.emitData("td-test end\r\n");
    const deadline = Date.now() + 5000;
    while (!Buffer.concat(received).toString("latin1").includes("td-test end")) {
      if (Date.now() > deadline) throw new Error("output did not arrive");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // Byte for byte to the view, and nothing written back to the program.
    expect(Buffer.concat(received)).toEqual(Buffer.concat([bytes, Buffer.from("td-test end\r\n")]));
    expect(pty.writes).toEqual([]);
    // A later view gets them in its snapshot as they were, and no sequence of its own built from them.
    const late = await connect(pipePath, { requestTimeoutMs: 5000 });
    cleanups.push(() => late.close());
    const attached = await late.request("session.attach", { sessionId: session.id });
    expect(Buffer.from(attached.payload).toString("latin1")).toContain(Buffer.from(bytes).toString("latin1"));
    expect(pty.writes).toEqual([]);

    // The history keeps the bytes; the search strips the sequences and finds none of their content.
    const hits = (await client.request("history.search", { query: "td-test" })).result.hits;
    expect(hits.map((hit) => hit.line)).toEqual(["td-test end"]);
    await late.close();
    await client.close();
    await core.close?.();
    const stored: Uint8Array[] = [];
    for await (const entry of readHistory(dataDir, session.id)) stored.push(entry.data);
    expect(Buffer.concat(stored).toString("latin1")).toContain(Buffer.from(bytes).toString("latin1"));
    // Terminal output never reaches the log (spec diagnostics).
    const file = join(dataDir, "logs", "core.log");
    const log = existsSync(file) ? readFileSync(file, "utf8") : "";
    expect(log + stderr.join("")).not.toContain("td-test");
  });
});

import { describe, expect, it } from "vitest";
import { encodeFrame, FrameDecoder, MAX_PAYLOAD_BYTES } from "./frame.js";
import type { Frame } from "./frame.js";
import { negotiateHello, parseEvent, parseRequest, parseResponse } from "./guards.js";
import { PROTOCOL_VERSION } from "./model.js";

/** Goes through the real codec so tests see what a peer would see. */
function frame(header: unknown, payload?: Uint8Array): Frame {
  const frames = new FrameDecoder().push(encodeFrame(header, payload));
  return frames[0] as Frame;
}

const launch = { backend: "wsl", cwd: "/home/nic" };
const size = { cols: 80, rows: 24 };
const sessionInfo = {
  id: "s1",
  name: "Build",
  state: "Running",
  launch,
  size,
  loggingEnabled: true,
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:00.000Z",
};

function request(method: string, params: unknown, payload?: Uint8Array): Frame {
  return frame({ kind: "request", id: "r1", method, params }, payload);
}

function failure(result: { ok: boolean }): { code: string; message: string; id?: string } {
  if (result.ok) throw new Error("expected a parse failure");
  const failed = result as unknown as { id?: string; error: { code: string; message: string } };
  return { ...failed.error, ...(failed.id === undefined ? {} : { id: failed.id }) };
}

describe("parseRequest", () => {
  it("accepts every phase-1 method with valid params", () => {
    const valid: [string, unknown][] = [
      ["hello", { protocolVersion: "1.0", clientId: "c1", clientKind: "desktop" }],
      ["session.create", { name: "Build", launch }],
      ["session.create", { name: "Build", launch, size, loggingEnabled: false, workspaceId: "w1" }],
      ["session.list", {}],
      ["session.attach", { sessionId: "s1" }],
      ["session.attach", { sessionId: "s1", size }],
      ["session.detach", { viewId: "v1" }],
      ["session.resize", { viewId: "v1", size }],
      ["session.claimWriter", { viewId: "v1" }],
      ["session.kill", { sessionId: "s1" }],
      ["core.shutdown", {}],
    ];
    for (const [method, params] of valid) {
      const parsed = parseRequest(request(method, params));
      expect(parsed.ok, `${method}: ${JSON.stringify(parsed)}`).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.id).toBe("r1");
        expect(parsed.value.method).toBe(method);
        expect(parsed.value.params).toEqual(params);
      }
    }
  });

  it("returns input bytes for session.input", () => {
    const parsed = parseRequest(request("session.input", { viewId: "v1" }, Uint8Array.from([3, 0, 255])));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(Array.from(parsed.value.payload)).toEqual([3, 0, 255]);
  });

  it("rejects session.input without payload", () => {
    const error = failure(parseRequest(request("session.input", { viewId: "v1" })));
    expect(error.code).toBe("bad_request");
    expect(error.message).toMatch(/session\.input.*payload/i);
  });

  it("rejects payload on methods that carry none", () => {
    const error = failure(parseRequest(request("session.kill", { sessionId: "s1" }, Uint8Array.from([1]))));
    expect(error.code).toBe("bad_request");
    expect(error.message).toMatch(/session\.kill.*no payload/i);
  });

  it("names the method for an unknown method and keeps the id", () => {
    const error = failure(parseRequest(request("session.fliegen", {})));
    expect(error.code).toBe("bad_request");
    expect(error.message).toContain("session.fliegen");
    expect(error.id).toBe("r1");
  });

  it("names the missing required field", () => {
    const error = failure(parseRequest(request("session.resize", { viewId: "v1" })));
    expect(error.code).toBe("bad_request");
    expect(error.message).toContain("params.size");
    const noLaunch = failure(parseRequest(request("session.create", { name: "x" })));
    expect(noLaunch.message).toContain("params.launch");
  });

  it("rejects wrongly typed and out-of-range fields", () => {
    expect(failure(parseRequest(request("session.kill", { sessionId: 5 }))).message).toContain(
      "params.sessionId",
    );
    expect(
      failure(parseRequest(request("session.resize", { viewId: "v1", size: { cols: 0, rows: 24 } }))).message,
    ).toContain("params.size.cols");
    expect(
      failure(parseRequest(request("session.resize", { viewId: "v1", size: { cols: 80.5, rows: 24 } }))).code,
    ).toBe("bad_request");
    expect(
      failure(parseRequest(request("session.create", { name: "x", launch: { backend: "docker", cwd: "/" } })))
        .message,
    ).toContain("params.launch.backend");
  });

  it("rejects params that are not an object", () => {
    expect(failure(parseRequest(request("session.list", null))).code).toBe("bad_request");
  });

  it("rejects wrong kind, missing id and missing method", () => {
    expect(failure(parseRequest(frame({ kind: "event", event: "session.output" }))).message).toContain(
      "kind",
    );
    expect(
      failure(parseRequest(frame({ kind: "request", method: "session.list", params: {} }))).message,
    ).toContain("id");
    expect(failure(parseRequest(frame({ kind: "request", id: "r1", params: {} }))).message).toContain(
      "method",
    );
  });

  it("rejects hello with an invalid version format", () => {
    const error = failure(
      parseRequest(request("hello", { protocolVersion: "abc", clientId: "c", clientKind: "desktop" })),
    );
    expect(error.code).toBe("bad_request");
    expect(error.message).toContain("params.protocolVersion");
  });

  it("rejects a version with leading zeros", () => {
    const error = failure(
      parseRequest(request("hello", { protocolVersion: "01.0", clientId: "c", clientKind: "desktop" })),
    );
    expect(error.code).toBe("bad_request");
  });

  it("rejects distro for backend windows and shell for backend wsl", () => {
    const windows = failure(
      parseRequest(
        request("session.create", {
          name: "x",
          launch: { backend: "windows", cwd: "C:\\", distro: "Ubuntu" },
        }),
      ),
    );
    expect(windows.message).toContain("params.launch.distro");
    const wsl = failure(
      parseRequest(
        request("session.create", { name: "x", launch: { backend: "wsl", cwd: "/", shell: "cmd" } }),
      ),
    );
    expect(wsl.message).toContain("params.launch.shell");
    expect(
      parseRequest(
        request("session.create", { name: "x", launch: { backend: "windows", cwd: "C:\\", shell: "cmd" } }),
      ).ok,
    ).toBe(true);
    expect(
      parseRequest(
        request("session.create", { name: "x", launch: { backend: "wsl", cwd: "/", distro: "Ubuntu" } }),
      ).ok,
    ).toBe(true);
  });

  it("limits id length to 128 characters", () => {
    expect(failure(parseRequest(request("session.kill", { sessionId: "s".repeat(129) }))).message).toContain(
      "params.sessionId",
    );
    expect(parseRequest(request("session.kill", { sessionId: "s".repeat(128) })).ok).toBe(true);
    expect(failure(parseRequest(request("session.claimWriter", { viewId: "v".repeat(129) }))).code).toBe(
      "bad_request",
    );
    expect(
      failure(
        parseRequest(frame({ kind: "request", id: "i".repeat(129), method: "session.list", params: {} })),
      ).id,
    ).toBeUndefined();
    expect(
      failure(
        parseRequest(
          request("hello", { protocolVersion: "1.0", clientId: "c".repeat(129), clientKind: "desktop" }),
        ),
      ).message,
    ).toContain("params.clientId");
  });

  it("truncates untrusted values in error messages", () => {
    const long = "x".repeat(10_000);
    expect(failure(parseRequest(request(long, {}))).message.length).toBeLessThan(200);
    expect(failure(parseEvent(frame({ kind: "event", event: long, data: {} }))).message.length).toBeLessThan(
      200,
    );
    const version = failure(
      parseRequest(request("hello", { protocolVersion: long, clientId: "c", clientKind: "desktop" })),
    );
    expect(version.message.length).toBeLessThan(200);
    expect(
      failure(
        parseRequest(
          request("session.create", { name: "x", launch: { backend: "wsl", cwd: "/", env: { [long]: 1 } } }),
        ),
      ).message.length,
    ).toBeLessThan(200);
  });
});

describe("parseResponse", () => {
  it("parses results per method", () => {
    const ok = (result: unknown, payload?: Uint8Array): Frame =>
      frame({ kind: "response", id: "r1", result }, payload);
    expect(parseResponse(ok({ session: sessionInfo }), "session.create").ok).toBe(true);
    expect(parseResponse(ok({ sessions: [sessionInfo] }), "session.list").ok).toBe(true);
    expect(parseResponse(ok({}), "session.detach").ok).toBe(true);
    expect(parseResponse(ok({}), "core.shutdown").ok).toBe(true);
    expect(parseResponse(ok({ protocolVersion: "1.0" }), "hello").ok).toBe(true);
  });

  it("returns snapshot bytes, size and writer for session.attach", () => {
    const snapshot = Uint8Array.from([27, 91, 72, 104, 105]);
    const parsed = parseResponse(
      frame({ kind: "response", id: "r1", result: { viewId: "v1", size, writerViewId: "v0" } }, snapshot),
      "session.attach",
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.value.ok) {
      expect(parsed.value.result).toEqual({ viewId: "v1", size, writerViewId: "v0" });
      expect(Array.from(parsed.value.payload)).toEqual([27, 91, 72, 104, 105]);
    }
  });

  it("allows an empty snapshot and no writer", () => {
    const parsed = parseResponse(
      frame({ kind: "response", id: "r1", result: { viewId: "v1", size } }),
      "session.attach",
    );
    expect(parsed.ok).toBe(true);
  });

  it("rejects payload on a response that carries none", () => {
    const parsed = parseResponse(
      frame({ kind: "response", id: "r1", result: { sessions: [] } }, Uint8Array.from([1])),
      "session.list",
    );
    expect(failure(parsed).code).toBe("bad_request");
  });

  it("parses an error response and rejects unknown error codes", () => {
    const parsed = parseResponse(
      frame({
        kind: "response",
        id: "r1",
        error: { code: "not_writer", message: "View v2 is not the writer" },
      }),
      "session.input",
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok && !parsed.value.ok) {
      expect(parsed.value.error).toEqual({ code: "not_writer", message: "View v2 is not the writer" });
    }
    const unknown = parseResponse(
      frame({ kind: "response", id: "r1", error: { code: "kaputt", message: "x" } }),
      "session.input",
    );
    expect(failure(unknown).message).toContain("error.code");
  });

  it("rejects responses with neither or both of result and error", () => {
    expect(failure(parseResponse(frame({ kind: "response", id: "r1" }), "session.list")).code).toBe(
      "bad_request",
    );
    expect(
      failure(
        parseResponse(
          frame({ kind: "response", id: "r1", result: {}, error: { code: "internal", message: "x" } }),
          "session.detach",
        ),
      ).code,
    ).toBe("bad_request");
  });

  it("rejects a malformed result with the field name", () => {
    const parsed = parseResponse(
      frame({ kind: "response", id: "r1", result: { viewId: "v1" } }),
      "session.attach",
    );
    expect(failure(parsed).message).toContain("result.size");
  });
});

describe("parseEvent", () => {
  it("returns output bytes for session.output", () => {
    const parsed = parseEvent(
      frame(
        { kind: "event", event: "session.output", data: { sessionId: "s1" } },
        Uint8Array.from([104, 105]),
      ),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.event).toBe("session.output");
      expect(parsed.value.data).toEqual({ sessionId: "s1" });
      expect(Array.from(parsed.value.payload)).toEqual([104, 105]);
    }
  });

  it("rejects session.output without bytes", () => {
    const parsed = parseEvent(frame({ kind: "event", event: "session.output", data: { sessionId: "s1" } }));
    expect(failure(parsed).message).toMatch(/session\.output.*payload/i);
  });

  it("accepts the other events", () => {
    const events: [string, unknown][] = [
      ["session.stateChanged", { sessionId: "s1", state: "Exited", lastExitCode: 0 }],
      ["session.resized", { sessionId: "s1", size }],
      ["view.writerChanged", { sessionId: "s1", writerViewId: "v1" }],
      ["view.writerChanged", { sessionId: "s1" }],
    ];
    for (const [event, data] of events) {
      const parsed = parseEvent(frame({ kind: "event", event, data }));
      expect(parsed.ok, event).toBe(true);
    }
  });

  it("rejects unknown events, bad state values and events with an id", () => {
    expect(failure(parseEvent(frame({ kind: "event", event: "session.boom", data: {} }))).message).toContain(
      "session.boom",
    );
    expect(
      failure(
        parseEvent(
          frame({ kind: "event", event: "session.stateChanged", data: { sessionId: "s1", state: "Weg" } }),
        ),
      ).message,
    ).toContain("data.state");
    expect(
      failure(
        parseEvent(
          frame({ kind: "event", id: "x", event: "session.resized", data: { sessionId: "s1", size } }),
        ),
      ).code,
    ).toBe("bad_request");
  });

  it("accepts output of the maximum size", () => {
    const parsed = parseEvent(
      frame(
        { kind: "event", event: "session.output", data: { sessionId: "s1" } },
        new Uint8Array(MAX_PAYLOAD_BYTES),
      ),
    );
    expect(parsed.ok).toBe(true);
  });
});

describe("negotiateHello", () => {
  const hello = (
    protocolVersion: string,
  ): { protocolVersion: string; clientId: string; clientKind: string } => ({
    protocolVersion,
    clientId: "c1",
    clientKind: "desktop",
  });

  it("answers with the core version for the same major version", () => {
    const result = negotiateHello(hello("1.7"));
    expect(result).toEqual({ ok: true, value: { protocolVersion: PROTOCOL_VERSION } });
  });

  it("returns protocol_mismatch for a different major version", () => {
    const error = failure(negotiateHello(hello("2.0")));
    expect(error.code).toBe("protocol_mismatch");
    expect(error.message).toContain("2.0");
    expect(error.message).toContain(PROTOCOL_VERSION);
  });

  it("does not treat a leading-zero major version as equal", () => {
    expect(failure(negotiateHello(hello("01.0"))).code).toBe("bad_request");
  });
});

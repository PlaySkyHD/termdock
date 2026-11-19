import { IpcError } from "@termdock/core";
import type { EventListener } from "@termdock/core";
import type { EventMap, EventName, Method } from "@termdock/protocol";
import { describe, expect, it, vi } from "vitest";
import { connectOrStartCore } from "./core-connection.js";
import type { CorePort } from "./core-connection.js";
import { CoreSupervisor, RESTART_LIMIT, RESTART_WINDOW_MS } from "./core-supervisor.js";
import type { SupervisorState } from "./core-supervisor.js";

/** One connection to a core: records requests, emits events and ends on demand (a crash or `close`). */
class FakeClient implements CorePort {
  readonly requests: Method[] = [];
  closed = false;
  private readonly listeners = new Map<EventName, Set<(data: never, payload: Uint8Array) => void>>();
  private readonly closeListeners = new Set<() => void>();

  constructor(readonly name: string) {}

  request = (async (method: Method) => {
    if (this.closed) throw new IpcError("closed", "Connection closed");
    this.requests.push(method);
    return { result: { backendUnavailable: [] }, payload: new Uint8Array() };
  }) as CorePort["request"];

  on<E extends EventName>(event: E, listener: EventListener<E>): { dispose: () => void } {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener as (data: never, payload: Uint8Array) => void);
    this.listeners.set(event, set);
    return { dispose: () => set.delete(listener as (data: never, payload: Uint8Array) => void) };
  }

  onClose(listener: () => void): { dispose: () => void } {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  async close(): Promise<void> {
    this.crash();
  }

  /** The core process ended: the connection closes without anybody asking. */
  crash(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of [...this.closeListeners]) listener();
  }

  emit<E extends EventName>(event: E, data: EventMap[E]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(data as never, new Uint8Array());
  }

  listenerCount(event: EventName): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}

class FakeClock {
  time = 0;
  now = (): number => this.time;
  sleep = async (ms: number): Promise<void> => {
    this.time += ms;
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

/** A supervisor whose `connect` hands out new clients (or fails while `failing` is set). */
function setup() {
  const clock = new FakeClock();
  const clients: FakeClient[] = [];
  const states: SupervisorState[] = [];
  const control = { failing: false };
  const connect = vi.fn(async () => {
    if (control.failing) throw new IpcError("closed", "Cannot connect: ENOENT");
    const client = new FakeClient(`c${clients.length + 1}`);
    clients.push(client);
    return client;
  });
  const supervisor = new CoreSupervisor({
    connect,
    now: clock.now,
    sleep: clock.sleep,
    onState: (state) => states.push(state),
    log: () => {},
  });
  return { clock, clients, states, control, connect, supervisor };
}

describe("CoreSupervisor", () => {
  it("connects once at the start and reports connected", async () => {
    const { supervisor, connect, states } = setup();

    await supervisor.start();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(supervisor.state).toBe("connected");
    expect(states).toEqual(["connected"]);
  });

  it("throws when the first connect fails and does not try again", async () => {
    const { supervisor, connect, control } = setup();
    control.failing = true;

    await expect(supervisor.start()).rejects.toThrow(/ENOENT/);
    await flush();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(supervisor.state).toBe("failed");
  });

  it("connects again when the connection ends, through the same port", async () => {
    const { supervisor, clients, states } = setup();
    await supervisor.start();

    clients[0]!.crash();
    expect(supervisor.state).toBe("restarting");
    await flush();

    expect(clients).toHaveLength(2);
    expect(supervisor.state).toBe("connected");
    expect(states).toEqual(["connected", "restarting", "connected"]);
    await supervisor.port.request("session.list", {});
    expect(clients[1]!.requests).toEqual(["session.list"]);
  });

  it("only connects when another core holds the pipe already", async () => {
    const clock = new FakeClock();
    const startCore = vi.fn();
    const clients: FakeClient[] = [];
    const supervisor = new CoreSupervisor({
      // The main process's wiring: connect first, start only on ENOENT. A core someone else started answers.
      connect: async () =>
        (
          await connectOrStartCore({
            connect: async () => {
              const client = new FakeClient(`c${clients.length + 1}`);
              clients.push(client);
              return client;
            },
            startCore,
            sleep: clock.sleep,
            now: clock.now,
          })
        ).client,
      now: clock.now,
      sleep: clock.sleep,
      log: () => {},
    });
    await supervisor.start();

    clients[0]!.crash();
    await flush();

    expect(supervisor.state).toBe("connected");
    expect(clients).toHaveLength(2);
    expect(startCore).not.toHaveBeenCalled();
  });

  it(`stops after ${RESTART_LIMIT} restarts within ${RESTART_WINDOW_MS / 60_000} minutes`, async () => {
    const { supervisor, clients, connect, states, clock } = setup();
    await supervisor.start();

    for (let i = 0; i < RESTART_LIMIT; i++) {
      clock.time += 10_000;
      clients.at(-1)!.crash();
      await flush();
      expect(supervisor.state).toBe("connected");
    }
    clock.time += 10_000;
    clients.at(-1)!.crash();
    await flush();

    expect(supervisor.state).toBe("failed");
    expect(connect).toHaveBeenCalledTimes(1 + RESTART_LIMIT);
    expect(states.at(-1)).toBe("failed");
    await expect(supervisor.port.request("session.list", {})).rejects.toMatchObject({ code: "closed" });
  });

  it("forgets restarts older than the window", async () => {
    const { supervisor, clients, clock } = setup();
    await supervisor.start();

    for (let i = 0; i < RESTART_LIMIT; i++) {
      clients.at(-1)!.crash();
      await flush();
    }
    clock.time += RESTART_WINDOW_MS + 1;
    clients.at(-1)!.crash();
    await flush();

    expect(supervisor.state).toBe("connected");
  });

  it("counts failed restarts and waits between them", async () => {
    const { supervisor, clients, control, connect, clock } = setup();
    await supervisor.start();
    control.failing = true;
    const before = clock.time;

    clients[0]!.crash();
    await flush();

    expect(supervisor.state).toBe("failed");
    expect(connect).toHaveBeenCalledTimes(1 + RESTART_LIMIT);
    // A wait between the failed tries, none after the last.
    expect(clock.time - before).toBe((RESTART_LIMIT - 1) * 1_000);
  });

  it("restarts from failed on the button and resets the count", async () => {
    const { supervisor, clients, control, connect } = setup();
    await supervisor.start();
    control.failing = true;
    clients[0]!.crash();
    await flush();
    expect(supervisor.state).toBe("failed");
    control.failing = false;

    supervisor.restart();
    expect(supervisor.state).toBe("restarting");
    await flush();
    expect(supervisor.state).toBe("connected");

    // The count starts over with the button's restart as the first one.
    for (let i = 1; i < RESTART_LIMIT; i++) {
      clients.at(-1)!.crash();
      await flush();
      expect(supervisor.state).toBe("connected");
    }
    clients.at(-1)!.crash();
    await flush();
    expect(supervisor.state).toBe("failed");
    expect(connect).toHaveBeenCalledTimes(1 + RESTART_LIMIT + RESTART_LIMIT);
  });

  it("ignores the button while connected or restarting", async () => {
    const { supervisor, connect } = setup();
    await supervisor.start();

    supervisor.restart();
    await flush();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(supervisor.state).toBe("connected");
  });

  it("never restarts after stop, also when the core ends on a shutdown", async () => {
    const { supervisor, clients, connect } = setup();
    await supervisor.start();

    supervisor.stop();
    clients[0]!.crash();
    await flush();
    supervisor.restart();
    await flush();

    expect(connect).toHaveBeenCalledTimes(1);
    expect(supervisor.state).toBe("stopped");
  });

  it("close stops and ends the connection", async () => {
    const { supervisor, clients, connect } = setup();
    await supervisor.start();

    await supervisor.close();
    await flush();

    expect(clients[0]!.closed).toBe(true);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(supervisor.state).toBe("stopped");
  });

  it("closes a connection that arrives after stop", async () => {
    const { supervisor, clients, connect } = setup();
    await supervisor.start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = connect.getMockImplementation()!;
    connect.mockImplementation(async () => {
      await gate;
      return original();
    });

    clients[0]!.crash();
    supervisor.stop();
    release();
    await flush();

    expect(clients).toHaveLength(2);
    expect(clients[1]!.closed).toBe(true);
    // A quit that keeps the sessions leaves the core running (ADR 0001).
    expect(clients[1]!.requests).toEqual([]);
    expect(supervisor.state).toBe("stopped");
  });

  it("reports the restart of the button as a change from failed to restarting", async () => {
    const { supervisor, clients, control, states } = setup();
    await supervisor.start();
    control.failing = true;
    clients[0]!.crash();
    await flush();
    control.failing = false;
    states.length = 0;

    supervisor.restart();
    await flush();

    expect(states).toEqual(["restarting", "connected"]);
  });

  it("is disconnected only while restarting or failed", async () => {
    const { supervisor, clients, control } = setup();
    await supervisor.start();
    expect(supervisor.disconnected()).toBe(false);
    control.failing = true;

    clients[0]!.crash();
    expect(supervisor.disconnected()).toBe(true);
    await flush();
    expect(supervisor.state).toBe("failed");
    expect(supervisor.disconnected()).toBe(true);
    supervisor.stop();
    expect(supervisor.disconnected()).toBe(false);
  });

  it("shuts down a core that a restart brings back after a quit that ends the sessions", async () => {
    const { supervisor, clients, connect } = setup();
    await supervisor.start();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = connect.getMockImplementation()!;
    connect.mockImplementation(async () => {
      await gate;
      return original();
    });

    clients[0]!.crash();
    supervisor.stop({ stopSessions: true });
    const closing = supervisor.close();
    release();
    await closing;
    await flush();

    expect(clients[1]!.requests).toEqual(["core.shutdown"]);
    expect(clients[1]!.closed).toBe(true);
  });

  it("does not wait for ever in close for a restart that hangs", async () => {
    const { supervisor, clients, connect } = setup();
    await supervisor.start();
    connect.mockImplementation(() => new Promise<never>(() => {}));
    clients[0]!.crash();

    await supervisor.close();

    expect(supervisor.state).toBe("stopped");
  });

  it("moves event subscriptions to the new connection and drops them on dispose", async () => {
    const { supervisor, clients } = setup();
    await supervisor.start();
    const seen: string[] = [];
    const subscription = supervisor.port.on("session.created", ({ session }) => seen.push(session.id));
    clients[0]!.emit("session.created", { session: { id: "a" } as EventMap["session.created"]["session"] });

    clients[0]!.crash();
    await flush();
    clients[1]!.emit("session.created", { session: { id: "b" } as EventMap["session.created"]["session"] });
    subscription.dispose();
    clients[1]!.emit("session.created", { session: { id: "c" } as EventMap["session.created"]["session"] });

    expect(seen).toEqual(["a", "b"]);
    expect(clients[1]!.listenerCount("session.created")).toBe(0);
  });

  it("tells close listeners of the port after its state is set", async () => {
    const { supervisor, clients } = setup();
    await supervisor.start();
    const seen: SupervisorState[] = [];
    supervisor.port.onClose(() => seen.push(supervisor.state));

    clients[0]!.crash();
    await flush();
    supervisor.stop();
    clients[1]!.crash();

    expect(seen).toEqual(["restarting", "stopped"]);
  });
});

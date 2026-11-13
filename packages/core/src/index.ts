export type * from "./backend/types.js";
export { FakeBackend, FakePty } from "./backend/fake.js";
export type { FakeBackendCall, FakeBackendOptions } from "./backend/fake.js";
export { CoreError } from "./session/errors.js";
export { canTransition, transition } from "./session/lifecycle.js";
export { OUTPUT_BUFFER_BYTES, SessionRegistry } from "./session/registry.js";
export type {
  AttachResult,
  CreateSessionInput,
  OutputEvent,
  ResizedEvent,
  SessionRegistryOptions,
  StateChangeEvent,
  WriterChangedEvent,
} from "./session/registry.js";

// wsl backend
export { DEFAULT_TMUX_SOCKET, WslBackend } from "./backend/wsl/backend.js";
export type { PtySpawner, WslBackendOptions, WslRunner } from "./backend/wsl/backend.js";
export type { RunResult } from "./backend/wsl/commands.js";
export { DistroKeepalive } from "./backend/wsl/keepalive.js";
export type { KeepaliveProcess, KeepaliveSpawner } from "./backend/wsl/keepalive.js";
export type { PtyProcess } from "./backend/wsl/pty.js";
export { wslPath } from "./backend/wsl/paths.js";

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

// ipc
export { defaultPipeName, sanitizePipeUser } from "./ipc/pipe-name.js";
export { AlreadyRunningError, CoreServer, DEFAULT_MAX_BUFFERED_BYTES } from "./ipc/server.js";
export type { CoreServerOptions } from "./ipc/server.js";
export { connect, CoreClient, IpcError } from "./ipc/client.js";
export type { ConnectOptions, EventListener, RequestResult } from "./ipc/client.js";
export { ALREADY_RUNNING_EXIT_CODE, runCore } from "./bin/run-core.js";
export type { RunCoreOptions, RunCoreResult } from "./bin/run-core.js";

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

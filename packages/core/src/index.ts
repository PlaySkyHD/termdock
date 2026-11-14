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

// storage
export type { ReconciledSession, RestoreResult } from "./session/registry.js";
export { DATABASE_FILE, openDatabase, openStorage, resolveDataDir } from "./storage/database.js";
export type { OpenStorageOptions, Storage } from "./storage/database.js";
export { MIGRATIONS, migrate, schemaVersion } from "./storage/migrations.js";
export type { Migration } from "./storage/migrations.js";
export { InMemorySessionRepository, SqliteSessionRepository } from "./storage/session-repository.js";
export type { SessionRepository } from "./storage/session-repository.js";
export {
  DEFAULT_FLUSH_DELAY_MS,
  DEFAULT_MAX_PENDING_BYTES,
  ENTRY_HEADER_BYTES,
  HISTORY_SEGMENT_FILES,
  HistoryStore,
  MAX_ENTRY_DATA_BYTES,
  historyDir,
  historySegmentPath,
  readHistory,
  segmentCapBytes,
} from "./storage/history-store.js";
export type {
  HistoryEntry,
  HistorySettings,
  HistoryStats,
  HistoryStoreOptions,
} from "./storage/history-store.js";
export { recordHistory } from "./storage/history-recorder.js";
export { InMemoryLayoutRepository, SqliteLayoutRepository } from "./storage/layout-repository.js";
export type { LayoutRepository, StoredLayout } from "./storage/layout-repository.js";
export { InMemoryWorkspaceRepository, SqliteWorkspaceRepository } from "./storage/workspace-repository.js";
export type { WorkspaceRepository } from "./storage/workspace-repository.js";

// workspaces
export { defaultCwd } from "./workspace/default-cwd.js";
export type { DefaultCwdInput } from "./workspace/default-cwd.js";
export { projectPathProblem } from "./workspace/paths.js";
export { WorkspaceService } from "./workspace/service.js";

// ipc
export { defaultPipeName, sanitizePipeUser } from "./ipc/pipe-name.js";
export { AlreadyRunningError, CoreServer, DEFAULT_MAX_BUFFERED_BYTES } from "./ipc/server.js";
export type { CoreServerOptions } from "./ipc/server.js";
export { connect, CoreClient, IpcError } from "./ipc/client.js";
export type { ConnectOptions, EventListener, RequestResult } from "./ipc/client.js";
export { ALREADY_RUNNING_EXIT_CODE, runCore } from "./bin/run-core.js";
export type { RunCoreOptions, RunCoreResult } from "./bin/run-core.js";

// wsl backend
export { DEFAULT_TMUX_SOCKET, WslBackend } from "./backend/wsl/backend.js";
export type { PtySpawner, WslBackendOptions, WslRunner } from "./backend/wsl/backend.js";
export type { RunResult } from "./backend/wsl/commands.js";
export { DistroKeepalive } from "./backend/wsl/keepalive.js";
export type { KeepaliveProcess, KeepaliveSpawner } from "./backend/wsl/keepalive.js";
export type { PtyProcess } from "./backend/wsl/pty.js";
export { wslPath } from "./backend/wsl/paths.js";

// pipe security
export { DEFAULT_HELLO_TIMEOUT_MS, DEFAULT_MAX_PENDING_HANDSHAKES } from "./ipc/server.js";
export { foreignAllowEntries, grantsWrite, parseDacl } from "./ipc/pipe-acl.js";
export type { DaclEntry } from "./ipc/pipe-acl.js";

// assembly
export { DEFAULT_REATTACH_DELAYS_MS } from "./session/registry.js";

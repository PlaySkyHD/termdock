// Preload (sandboxed, CommonJS): exposes the narrow bridge API as `window.termdock` (ADR 0002, ADR 0006).
// A sandboxed preload cannot load local modules, so only types come from ../shared/bridge.ts.
// A CommonJS file under verbatimModuleSyntax must import with `import = require`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import electron = require("electron");
import type {
  BridgeCall,
  BridgeEvent,
  BridgeResult,
  BridgeResults,
  CALL_CHANNEL,
  EVENT_CHANNEL,
  TermdockApi,
} from "../shared/bridge.js" with { "resolution-mode": "import" };

const { contextBridge, ipcRenderer } = electron;
const callChannel: typeof CALL_CHANNEL = "termdock:call";
const eventChannel: typeof EVENT_CHANNEL = "termdock:event";

async function call<M extends BridgeCall["method"]>(
  request: Extract<BridgeCall, { method: M }>,
): Promise<BridgeResults[M]> {
  const result = (await ipcRenderer.invoke(callChannel, request)) as BridgeResult<BridgeResults[M]>;
  if (result.ok) return result.value;
  // Errors crossing contextBridge keep only their message; the code travels in it.
  throw new Error(`[${result.error.code}] ${result.error.message}`);
}

const api: TermdockApi = {
  coreStatus: () => call({ method: "coreStatus" }),
  listSessions: () => call({ method: "listSessions" }),
  createSession: (params) => call({ method: "createSession", params }),
  attach: (sessionId, size) => call({ method: "attach", sessionId, size }),
  detach: async (viewId) => void (await call({ method: "detach", viewId })),
  input: async (viewId, data) => void (await call({ method: "input", viewId, data })),
  resize: async (viewId, size) => void (await call({ method: "resize", viewId, size })),
  claimWriter: async (viewId) => void (await call({ method: "claimWriter", viewId })),
  listWorkspaces: () => call({ method: "listWorkspaces" }),
  createWorkspace: async (name) => void (await call({ method: "createWorkspace", name })),
  updateWorkspace: async (workspaceId, name) =>
    void (await call({ method: "updateWorkspace", workspaceId, name })),
  deleteWorkspace: async (workspaceId) => void (await call({ method: "deleteWorkspace", workspaceId })),
  createProject: async (workspaceId, name, path, backend) =>
    void (await call({ method: "createProject", workspaceId, name, path, backend })),
  updateProject: async (projectId, name) => void (await call({ method: "updateProject", projectId, name })),
  deleteProject: async (projectId) => void (await call({ method: "deleteProject", projectId })),
  updateSession: (sessionId, change) => call({ method: "updateSession", sessionId, ...change }),
  archiveSession: async (sessionId) => void (await call({ method: "archiveSession", sessionId })),
  deleteSession: async (sessionId) => void (await call({ method: "deleteSession", sessionId })),
  restartSession: async (sessionId) => void (await call({ method: "restartSession", sessionId })),
  windowLayout: () => call({ method: "windowLayout" }),
  reportLayout: async (window) => void (await call({ method: "reportLayout", window })),
  answerQuit: async (requestId, { choice, remember }) =>
    void (await call({ method: "answerQuit", requestId, choice, remember })),
  quitShown: async (requestId) => void (await call({ method: "quitShown", requestId })),
  searchHistory: (query, limit) =>
    call({ method: "searchHistory", query, ...(limit === undefined ? {} : { limit }) }),
  getSettings: () => call({ method: "getSettings" }),
  updateSettings: (settings) => call({ method: "updateSettings", settings }),
  listProfiles: () => call({ method: "listProfiles" }),
  createProfile: (profile) => call({ method: "createProfile", profile }),
  updateProfile: (profileId, change) => call({ method: "updateProfile", profileId, change }),
  deleteProfile: async (profileId) => void (await call({ method: "deleteProfile", profileId })),
  listDistros: () => call({ method: "listDistros" }),
  restartCore: async () => void (await call({ method: "restartCore" })),
  coreConnection: () => call({ method: "coreConnection" }),
  transferHover: async (item, at) => void (await call({ method: "transferHover", item, at })),
  transferHoverEnd: async () => void (await call({ method: "transferHoverEnd" })),
  transferDrop: async (item, at, whole) => void (await call({ method: "transferDrop", item, at, whole })),
  transferAttached: async (transferId, views) =>
    void (await call({ method: "transferAttached", transferId, ...(views === undefined ? {} : { views }) })),
  updateState: () => call({ method: "updateState" }),
  answerUpdate: async (choice) => void (await call({ method: "answerUpdate", choice })),
  onEvent: (listener) => {
    const handler = (_event: unknown, payload: BridgeEvent): void => listener(payload);
    ipcRenderer.on(eventChannel, handler);
    return () => void ipcRenderer.removeListener(eventChannel, handler);
  },
};

contextBridge.exposeInMainWorld("termdock", api);

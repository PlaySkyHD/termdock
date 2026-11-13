// Hand-written runtime guards for the IPC boundary (ADR 0002). Incoming headers are untrusted data.
// Parsers never throw on bad input: they return a ParseFailure with code "bad_request" and a readable message.

import type { Frame } from "./frame.js";
import { EVENT_NAMES, EVENT_PAYLOAD, METHODS, REQUEST_PAYLOAD, RESPONSE_PAYLOAD } from "./messages.js";
import type {
  ErrorBody,
  EventName,
  HelloParams,
  HelloResult,
  Method,
  ParsedEvent,
  ParsedRequest,
  ParsedResponse,
  ParseFailure,
  ParseResult,
  PayloadRule,
} from "./messages.js";
import {
  ERROR_CODES,
  LAYOUT_VERSION,
  MAX_LAYOUT_BYTES,
  MAX_LAYOUT_ID_LENGTH,
  MAX_LAYOUT_WINDOWS,
  MAX_PANES_PER_TAB,
  MAX_TAB_TITLE_LENGTH,
  MAX_TABS_PER_WINDOW,
  PROTOCOL_VERSION,
  SESSION_STATES,
} from "./model.js";
import type { BackendKind, LayoutDocument } from "./model.js";

export const MAX_TERMINAL_DIMENSION = 10_000;
const MAX_CLIENT_KIND_LENGTH = 64;
const MAX_ID_LENGTH = 128;
const MAX_QUOTED_LENGTH = 64;
/** No leading zeros, so "01.0" cannot pass as major version 1. */
const VERSION_FORMAT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Untrusted values in error messages are cut so a peer cannot inflate them. */
function quote(value: string): string {
  return value.length > MAX_QUOTED_LENGTH ? `${value.slice(0, MAX_QUOTED_LENGTH)}...` : value;
}

/** Thrown inside the guards only; the public parsers turn it into a ParseFailure. */
class Invalid extends Error {}

type Check = (value: unknown, path: string) => void;
type Rec = Record<string, unknown>;

function fail(message: string): never {
  throw new Invalid(message);
}

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Rec {
  if (!isRecord(value)) fail(`${path} must be an object`);
  return value;
}

function present(obj: Rec, key: string, path: string): unknown {
  const value = obj[key];
  if (value === undefined) fail(`${path}.${key} is required`);
  return value;
}

function string(obj: Rec, key: string, path: string): string {
  const value = present(obj, key, path);
  if (typeof value !== "string" || value.length === 0) fail(`${path}.${key} must be a non-empty string`);
  if ((key === "id" || key.endsWith("Id")) && value.length > MAX_ID_LENGTH) {
    fail(`${path}.${key} must be at most ${MAX_ID_LENGTH} characters`);
  }
  return value;
}

const isId: Check = (value, path) => {
  if (typeof value !== "string" || value.length === 0) fail(`${path} must be a non-empty string`);
  if (value.length > MAX_ID_LENGTH) fail(`${path} must be at most ${MAX_ID_LENGTH} characters`);
};

function optional(obj: Rec, key: string, path: string, check: Check): void {
  if (obj[key] !== undefined) check(obj[key], `${path}.${key}`);
}

const isNonEmptyString: Check = (value, path) => {
  if (typeof value !== "string" || value.length === 0) fail(`${path} must be a non-empty string`);
};

const isBoolean: Check = (value, path) => {
  if (typeof value !== "boolean") fail(`${path} must be a boolean`);
};

const isInteger: Check = (value, path) => {
  if (typeof value !== "number" || !Number.isInteger(value)) fail(`${path} must be an integer`);
};

function oneOf(allowed: readonly string[]): Check {
  return (value, path) => {
    if (typeof value !== "string" || !allowed.includes(value))
      fail(`${path} must be one of ${allowed.join(", ")}`);
  };
}

function dimension(obj: Rec, key: string, path: string): void {
  const value = present(obj, key, path);
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_TERMINAL_DIMENSION) {
    fail(`${path}.${key} must be an integer from 1 to ${MAX_TERMINAL_DIMENSION}`);
  }
}

const checkSize: Check = (value, path) => {
  const obj = record(value, path);
  dimension(obj, "cols", path);
  dimension(obj, "rows", path);
};

const isBackendKind = oneOf(["wsl", "windows"] satisfies BackendKind[]);

const checkLaunch: Check = (value, path) => {
  const obj = record(value, path);
  isBackendKind(present(obj, "backend", path), `${path}.backend`);
  string(obj, "cwd", path);
  const backend = obj["backend"];
  if (backend === "windows" && obj["distro"] !== undefined) {
    fail(`${path}.distro is only allowed for backend "wsl"`);
  }
  if (backend === "wsl" && obj["shell"] !== undefined) {
    fail(`${path}.shell is only allowed for backend "windows"`);
  }
  optional(obj, "distro", path, isNonEmptyString);
  optional(obj, "shell", path, oneOf(["pwsh", "powershell", "cmd"]));
  optional(obj, "command", path, (command, commandPath) => {
    if (!Array.isArray(command)) fail(`${commandPath} must be an array of strings`);
    command.forEach((part, index) => {
      if (typeof part !== "string") fail(`${commandPath}[${index}] must be a string`);
    });
  });
  optional(obj, "env", path, (env, envPath) => {
    for (const [name, entry] of Object.entries(record(env, envPath))) {
      if (typeof entry !== "string") fail(`${envPath}.${quote(name)} must be a string`);
    }
  });
};

const checkSessionInfo: Check = (value, path) => {
  const obj = record(value, path);
  string(obj, "id", path);
  string(obj, "name", path);
  oneOf(SESSION_STATES)(present(obj, "state", path), `${path}.state`);
  checkLaunch(present(obj, "launch", path), `${path}.launch`);
  checkSize(present(obj, "size", path), `${path}.size`);
  isBoolean(present(obj, "loggingEnabled", path), `${path}.loggingEnabled`);
  string(obj, "createdAt", path);
  string(obj, "updatedAt", path);
  for (const key of ["workspaceId", "profileId", "writerViewId"]) optional(obj, key, path, isId);
  optional(obj, "lastExitCode", path, isInteger);
};

// --- Layout document ------------------------------------------------------------------------

/** `sizes` of a split may deviate from 1 by this much (rounding in the UI). */
const SIZES_TOLERANCE = 0.01;

const isPositiveInteger: Check = (value, path) => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    fail(`${path} must be an integer of at least 1`);
  }
};

const isNonNegativeInteger: Check = (value, path) => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(`${path} must be an integer of at least 0`);
  }
};

const isPositiveNumber: Check = (value, path) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail(`${path} must be a number greater than 0`);
  }
};

/** Rejects keys the layout does not define, so nothing unknown gets stored. */
function onlyKeys(obj: Rec, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`${path}.${quote(key)} is not a known field`);
  }
}

/** A layout id (document, window, tab, pane, session): non-empty, at most MAX_LAYOUT_ID_LENGTH characters. */
function layoutId(obj: Rec, key: string, path: string): string {
  const value = present(obj, key, path);
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LAYOUT_ID_LENGTH) {
    fail(`${path}.${key} must be a string of 1 to ${MAX_LAYOUT_ID_LENGTH} characters`);
  }
  return value;
}

/** An id that is unique in the whole layout document. */
function claimId(obj: Rec, path: string, ids: Set<string>): string {
  const id = layoutId(obj, "id", path);
  if (ids.has(id)) fail(`${path}.id "${quote(id)}" is used more than once`);
  ids.add(id);
  return id;
}

interface PaneWalk {
  readonly ids: Set<string>;
  /** Ids of the leaves of the tab being checked. */
  readonly leaves: Set<string>;
}

function checkPaneNode(value: unknown, path: string, depth: number, walk: PaneWalk): void {
  const obj = record(value, path);
  const kind = present(obj, "kind", path);
  oneOf(["pane", "split"])(kind, `${path}.kind`);
  const id = claimId(obj, path, walk.ids);
  if (kind === "pane") {
    onlyKeys(obj, ["kind", "id", "sessionId"], path);
    layoutId(obj, "sessionId", path);
    walk.leaves.add(id);
    if (walk.leaves.size > MAX_PANES_PER_TAB) fail(`${path}: a tab has at most ${MAX_PANES_PER_TAB} panes`);
    return;
  }
  onlyKeys(obj, ["kind", "id", "direction", "children", "sizes"], path);
  oneOf(["row", "column"])(present(obj, "direction", path), `${path}.direction`);
  const children = present(obj, "children", path);
  if (!Array.isArray(children) || children.length < 2)
    fail(`${path}.children must be an array of at least 2`);
  const sizes = present(obj, "sizes", path);
  if (!Array.isArray(sizes) || sizes.length !== children.length) {
    fail(`${path}.sizes must be an array with one entry per child`);
  }
  let sum = 0;
  sizes.forEach((size, index) => {
    isPositiveNumber(size, `${path}.sizes[${index}]`);
    sum += size as number;
  });
  if (Math.abs(sum - 1) > SIZES_TOLERANCE) fail(`${path}.sizes must add up to about 1`);
  // Every split has at least 2 children, so this depth already means more panes than allowed.
  if (depth >= MAX_PANES_PER_TAB - 1) fail(`${path}: a tab has at most ${MAX_PANES_PER_TAB} panes`);
  children.forEach((child, index) => checkPaneNode(child, `${path}.children[${index}]`, depth + 1, walk));
}

function checkLayoutTab(value: unknown, path: string, ids: Set<string>): string {
  const obj = record(value, path);
  onlyKeys(obj, ["id", "title", "root", "activePaneId"], path);
  const id = claimId(obj, path, ids);
  optional(obj, "title", path, (title, titlePath) => {
    if (typeof title !== "string" || title.length > MAX_TAB_TITLE_LENGTH) {
      fail(`${titlePath} must be a string of at most ${MAX_TAB_TITLE_LENGTH} characters`);
    }
  });
  const walk: PaneWalk = { ids, leaves: new Set() };
  checkPaneNode(present(obj, "root", path), `${path}.root`, 0, walk);
  const activePaneId = layoutId(obj, "activePaneId", path);
  if (!walk.leaves.has(activePaneId)) {
    fail(`${path}.activePaneId "${quote(activePaneId)}" is not a pane of this tab`);
  }
  return id;
}

function checkLayoutWindow(value: unknown, path: string, ids: Set<string>): void {
  const obj = record(value, path);
  onlyKeys(obj, ["id", "bounds", "maximized", "sidebarVisible", "sidebarWidth", "tabs", "activeTabId"], path);
  claimId(obj, path, ids);
  optional(obj, "bounds", path, (bounds, boundsPath) => {
    const box = record(bounds, boundsPath);
    onlyKeys(box, ["x", "y", "width", "height"], boundsPath);
    isInteger(present(box, "x", boundsPath), `${boundsPath}.x`);
    isInteger(present(box, "y", boundsPath), `${boundsPath}.y`);
    isPositiveInteger(present(box, "width", boundsPath), `${boundsPath}.width`);
    isPositiveInteger(present(box, "height", boundsPath), `${boundsPath}.height`);
  });
  optional(obj, "maximized", path, isBoolean);
  optional(obj, "sidebarVisible", path, isBoolean);
  optional(obj, "sidebarWidth", path, isPositiveNumber);
  const tabs = present(obj, "tabs", path);
  if (!Array.isArray(tabs) || tabs.length > MAX_TABS_PER_WINDOW) {
    fail(`${path}.tabs must be an array of at most ${MAX_TABS_PER_WINDOW} tabs`);
  }
  const tabIds = tabs.map((tab, index) => checkLayoutTab(tab, `${path}.tabs[${index}]`, ids));
  if (tabIds.length === 0) {
    // An empty window shows only the sidebar and the empty state.
    if (obj["activeTabId"] !== undefined) fail(`${path}.activeTabId must be omitted when tabs is empty`);
    return;
  }
  const activeTabId = layoutId(obj, "activeTabId", path);
  if (!tabIds.includes(activeTabId))
    fail(`${path}.activeTabId "${quote(activeTabId)}" is not a tab of this window`);
}

const checkLayoutDocument: Check = (value, path) => {
  const obj = record(value, path);
  onlyKeys(obj, ["version", "windows"], path);
  if (present(obj, "version", path) !== LAYOUT_VERSION) fail(`${path}.version must be ${LAYOUT_VERSION}`);
  const windows = present(obj, "windows", path);
  if (!Array.isArray(windows) || windows.length > MAX_LAYOUT_WINDOWS) {
    fail(`${path}.windows must be an array of at most ${MAX_LAYOUT_WINDOWS} windows`);
  }
  const ids = new Set<string>();
  windows.forEach((window, index) => checkLayoutWindow(window, `${path}.windows[${index}]`, ids));
  // The structure is bounded by now, so serializing is cheap.
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  if (bytes > MAX_LAYOUT_BYTES) fail(`${path} is ${bytes} bytes, at most ${MAX_LAYOUT_BYTES} are allowed`);
};

/**
 * Checks a layout document: unique ids, at most 4 panes per tab, active ids that exist, valid `sizes`.
 * A `sessionId` without a session is fine (the app shows a placeholder). Never throws on bad input.
 */
export function validateLayoutDocument(value: unknown): ParseResult<LayoutDocument> {
  try {
    checkLayoutDocument(value, "layout");
    return { ok: true, value: value as LayoutDocument };
  } catch (error) {
    return badRequest(error);
  }
}

const checkEmpty: Check = (value, path) => {
  record(value, path);
};

function checkVersion(obj: Rec, path: string): void {
  const version = string(obj, "protocolVersion", path);
  if (!VERSION_FORMAT.test(version))
    fail(`${path}.protocolVersion must look like "1.0", got "${quote(version)}"`);
}

const checkHelloParams: Check = (value, path) => {
  const obj = record(value, path);
  checkVersion(obj, path);
  string(obj, "clientId", path);
  const kind = string(obj, "clientKind", path);
  if (kind.length > MAX_CLIENT_KIND_LENGTH) {
    fail(`${path}.clientKind must be at most ${MAX_CLIENT_KIND_LENGTH} characters`);
  }
};

const PARAMS_CHECK: Record<Method, Check> = {
  hello: checkHelloParams,
  "session.create": (value, path) => {
    const obj = record(value, path);
    string(obj, "name", path);
    checkLaunch(present(obj, "launch", path), `${path}.launch`);
    optional(obj, "workspaceId", path, isId);
    optional(obj, "profileId", path, isId);
    optional(obj, "size", path, checkSize);
    optional(obj, "loggingEnabled", path, isBoolean);
  },
  "session.list": checkEmpty,
  "session.attach": (value, path) => {
    const obj = record(value, path);
    string(obj, "sessionId", path);
    optional(obj, "size", path, checkSize);
  },
  "session.detach": (value, path) => string(record(value, path), "viewId", path),
  "session.input": (value, path) => string(record(value, path), "viewId", path),
  "session.resize": (value, path) => {
    const obj = record(value, path);
    string(obj, "viewId", path);
    checkSize(present(obj, "size", path), `${path}.size`);
  },
  "session.claimWriter": (value, path) => string(record(value, path), "viewId", path),
  "session.kill": (value, path) => string(record(value, path), "sessionId", path),
  "core.status": checkEmpty,
  "core.shutdown": (value, path) => optional(record(value, path), "stopSessions", path, isBoolean),
  "layout.get": checkEmpty,
  "layout.save": (value, path) => {
    const obj = record(value, path);
    checkLayoutDocument(present(obj, "layout", path), `${path}.layout`);
    optional(obj, "baseRevision", path, isNonNegativeInteger);
  },
};

const RESULT_CHECK: Record<Method, Check> = {
  hello: (value, path) => checkVersion(record(value, path), path),
  "session.create": (value, path) =>
    checkSessionInfo(present(record(value, path), "session", path), `${path}.session`),
  "session.list": (value, path) => {
    const sessions = present(record(value, path), "sessions", path);
    if (!Array.isArray(sessions)) fail(`${path}.sessions must be an array`);
    sessions.forEach((session, index) => checkSessionInfo(session, `${path}.sessions[${index}]`));
  },
  "session.attach": (value, path) => {
    const obj = record(value, path);
    string(obj, "viewId", path);
    checkSize(present(obj, "size", path), `${path}.size`);
    optional(obj, "writerViewId", path, isId);
  },
  "session.detach": checkEmpty,
  "session.input": checkEmpty,
  "session.resize": checkEmpty,
  "session.claimWriter": checkEmpty,
  "session.kill": checkEmpty,
  "core.status": (value, path) => {
    const kinds = present(record(value, path), "backendUnavailable", path);
    if (!Array.isArray(kinds)) fail(`${path}.backendUnavailable must be an array`);
    kinds.forEach((kind, index) => isBackendKind(kind, `${path}.backendUnavailable[${index}]`));
  },
  "core.shutdown": checkEmpty,
  "layout.get": (value, path) => {
    const obj = record(value, path);
    isNonNegativeInteger(present(obj, "revision", path), `${path}.revision`);
    optional(obj, "layout", path, checkLayoutDocument);
  },
  "layout.save": (value, path) =>
    isNonNegativeInteger(present(record(value, path), "revision", path), `${path}.revision`),
};

const EVENT_CHECK: Record<EventName, Check> = {
  "session.output": (value, path) => string(record(value, path), "sessionId", path),
  "session.stateChanged": (value, path) => {
    const obj = record(value, path);
    string(obj, "sessionId", path);
    oneOf(SESSION_STATES)(present(obj, "state", path), `${path}.state`);
    optional(obj, "lastExitCode", path, isInteger);
  },
  "session.resized": (value, path) => {
    const obj = record(value, path);
    string(obj, "sessionId", path);
    checkSize(present(obj, "size", path), `${path}.size`);
  },
  "view.writerChanged": (value, path) => {
    const obj = record(value, path);
    string(obj, "sessionId", path);
    optional(obj, "writerViewId", path, isId);
  },
};

function checkPayload(rule: PayloadRule, payload: Uint8Array, what: string): void {
  if (rule === "none" && payload.length > 0) fail(`${what} takes no payload`);
  if (rule === "nonEmpty" && payload.length === 0) fail(`${what} requires a non-empty payload`);
}

function isMethod(value: string): value is Method {
  return (METHODS as readonly string[]).includes(value);
}

function isEventName(value: string): value is EventName {
  return (EVENT_NAMES as readonly string[]).includes(value);
}

function checkKind(header: Rec, kind: string): void {
  if (header["kind"] !== kind) fail(`header.kind must be "${kind}"`);
}

function badRequest(error: unknown, id?: string): ParseFailure {
  if (!(error instanceof Invalid)) throw error;
  return {
    ok: false,
    ...(id === undefined ? {} : { id }),
    error: { code: "bad_request", message: error.message },
  };
}

function readableId(header: unknown): string | undefined {
  if (!isRecord(header)) return undefined;
  const id = header["id"];
  return typeof id === "string" && id.length > 0 && id.length <= MAX_ID_LENGTH ? id : undefined;
}

export function parseRequest(frame: Frame): ParseResult<ParsedRequest> {
  const id = readableId(frame.header);
  try {
    const header = record(frame.header, "header");
    checkKind(header, "request");
    const requestId = string(header, "id", "header");
    const method = string(header, "method", "header");
    if (!isMethod(method)) fail(`Unknown method "${quote(method)}"`);
    PARAMS_CHECK[method](present(header, "params", "header"), "params");
    checkPayload(REQUEST_PAYLOAD[method], frame.payload, method);
    return {
      ok: true,
      value: { id: requestId, method, params: header["params"], payload: frame.payload } as ParsedRequest,
    };
  } catch (error) {
    return badRequest(error, id);
  }
}

/** The method is known from the request with the same id; the caller keeps that mapping. */
export function parseResponse<M extends Method>(frame: Frame, method: M): ParseResult<ParsedResponse<M>> {
  const id = readableId(frame.header);
  try {
    const header = record(frame.header, "header");
    checkKind(header, "response");
    const responseId = string(header, "id", "header");
    const hasResult = header["result"] !== undefined;
    const hasError = header["error"] !== undefined;
    if (hasResult === hasError) fail("response must carry exactly one of result and error");
    if (hasError) {
      const error = record(header["error"], "error");
      oneOf(ERROR_CODES)(present(error, "code", "error"), "error.code");
      const message = present(error, "message", "error");
      if (typeof message !== "string") fail("error.message must be a string");
      checkPayload("none", frame.payload, "error response");
      return { ok: true, value: { id: responseId, ok: false, error: error as unknown as ErrorBody } };
    }
    RESULT_CHECK[method](header["result"], "result");
    checkPayload(RESPONSE_PAYLOAD[method], frame.payload, `${method} response`);
    return {
      ok: true,
      value: {
        id: responseId,
        ok: true,
        result: header["result"],
        payload: frame.payload,
      } as ParsedResponse<M>,
    };
  } catch (error) {
    return badRequest(error, id);
  }
}

export function parseEvent(frame: Frame): ParseResult<ParsedEvent> {
  try {
    const header = record(frame.header, "header");
    checkKind(header, "event");
    if (header["id"] !== undefined) fail("event must not carry an id");
    const event = string(header, "event", "header");
    if (!isEventName(event)) fail(`Unknown event "${quote(event)}"`);
    EVENT_CHECK[event](present(header, "data", "header"), "data");
    checkPayload(EVENT_PAYLOAD[event], frame.payload, event);
    return { ok: true, value: { event, data: header["data"], payload: frame.payload } as ParsedEvent };
  } catch (error) {
    return badRequest(error);
  }
}

function majorVersion(version: string): string {
  return version.split(".")[0] ?? "";
}

/** Compares the client's major version with PROTOCOL_VERSION. The server closes the connection on a mismatch. */
export function negotiateHello(params: HelloParams): ParseResult<HelloResult> {
  if (!VERSION_FORMAT.test(params.protocolVersion)) {
    return {
      ok: false,
      error: {
        code: "bad_request",
        message: `protocolVersion must look like "1.0", got "${quote(params.protocolVersion)}"`,
      },
    };
  }
  if (majorVersion(params.protocolVersion) !== majorVersion(PROTOCOL_VERSION)) {
    return {
      ok: false,
      error: {
        code: "protocol_mismatch",
        message: `Client speaks protocol ${quote(params.protocolVersion)}, core speaks ${PROTOCOL_VERSION}; major versions differ`,
      },
    };
  }
  return { ok: true, value: { protocolVersion: PROTOCOL_VERSION } };
}

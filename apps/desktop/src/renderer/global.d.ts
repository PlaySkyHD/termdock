import type { TermdockApi } from "../shared/bridge.js";

declare global {
  interface Window {
    /** Set by the preload (`contextBridge.exposeInMainWorld`). */
    readonly termdock: TermdockApi;
  }
}

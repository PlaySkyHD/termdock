// Preload (sandboxed, CommonJS): schmale API für den Renderer, kein Node-Zugriff.
const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("termdock", {
  hello: () => ipcRenderer.invoke("term:hello"),
  input: (data) => ipcRenderer.send("term:input", String(data)),
  resize: (cols, rows) => ipcRenderer.send("term:resize", { cols: Number(cols), rows: Number(rows) }),
  claimWriter: () => ipcRenderer.send("term:claim-writer"),
  reattach: () => ipcRenderer.invoke("term:reattach"),
  openWindow: () => ipcRenderer.send("term:open-window"),
  onData: (cb) => subscribe("pty:data", cb),
  onSnapshot: (cb) => subscribe("pty:snapshot", cb),
  onResized: (cb) => subscribe("pty:resized", cb),
  onWriterChanged: (cb) => subscribe("writer:changed", cb),
  onStatus: (cb) => subscribe("pty:status", cb),
});

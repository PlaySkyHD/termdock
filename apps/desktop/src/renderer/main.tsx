import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing");
createRoot(root).render(<App api={window.termdock} />);

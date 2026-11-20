// Generates `apps/desktop/resources/icon.ico` from `assets/icon.svg` (ADR 0007). Runs in Electron, because
// Chromium renders the SVG (including its text) without a further dependency:
//   npm run icon -w apps/desktop        (in agent shells first `unset ELECTRON_RUN_AS_NODE`)
// The result is checked in: the letter uses the system font (Segoe UI on Windows), so a run on another system
// may differ by a few pixels. Sizes up to 128 px are stored as 32-bit DIBs (what every Windows tool reads),
// 256 px as PNG, as Windows Vista and later expect.
import { Buffer } from "node:buffer";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, "..", "..", "..", "assets", "icon.svg");
const TARGET = path.join(here, "..", "resources", "icon.ico");
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

/** RGBA pixels (straight alpha, top-down) and a PNG of the SVG at `size` × `size`, drawn by Chromium. */
async function render(win, svg, size) {
  const result = await win.webContents.executeJavaScript(`(async () => {
    const image = new Image();
    image.src = "data:image/svg+xml;base64," + ${JSON.stringify(Buffer.from(svg).toString("base64"))};
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = ${size};
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0, ${size}, ${size});
    const rgba = Array.from(context.getImageData(0, 0, ${size}, ${size}).data);
    return { rgba, png: canvas.toDataURL("image/png") };
  })()`);
  return {
    rgba: Buffer.from(result.rgba),
    png: Buffer.from(result.png.slice("data:image/png;base64,".length), "base64"),
  };
}

/** A 32-bit BGRA DIB as an icon image: header with doubled height, bottom-up pixels, empty AND mask. */
function dib(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4;
      const to = ((size - 1 - y) * size + x) * 4;
      pixels[to] = rgba[from + 2];
      pixels[to + 1] = rgba[from + 1];
      pixels[to + 2] = rgba[from];
      pixels[to + 3] = rgba[from + 3];
    }
  }
  const maskRow = Math.ceil(size / 32) * 4;
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)]);
}

function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + 16 * index;
    head.writeUInt8(size >= 256 ? 0 : size, entry);
    head.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    head.writeUInt16LE(1, entry + 4);
    head.writeUInt16LE(32, entry + 6);
    head.writeUInt32LE(data.length, entry + 8);
    head.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((image) => image.data)]);
}

async function main() {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  try {
    await win.loadURL("about:blank");
    const svg = readFileSync(SOURCE, "utf8");
    const images = [];
    for (const size of SIZES) {
      const { rgba, png } = await render(win, svg, size);
      images.push({ size, data: size >= 256 ? png : dib(rgba, size) });
    }
    writeFileSync(TARGET, ico(images));
    console.log(`wrote ${TARGET} (${SIZES.join(", ")} px)`);
  } finally {
    win.destroy();
  }
}

// No top-level await: Electron emits `ready` only after the ESM entry has finished loading.
app
  .whenReady()
  .then(main)
  .then(
    () => app.exit(0),
    (error) => {
      console.error(error);
      app.exit(1);
    },
  );

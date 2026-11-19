// The installer configuration (ADR 0007): electron-builder.json, the NSIS additions and the icon.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { coreEntryPath } from "./core-process.js";

const desktop = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const config = JSON.parse(readFileSync(path.join(desktop, "electron-builder.json"), "utf8")) as {
  appId: string;
  productName: string;
  artifactName: string;
  publish: unknown;
  npmRebuild: boolean;
  asarUnpack: string[];
  files: string[];
  win: { icon: string; target: { target: string }[] };
  nsis: Record<string, unknown>;
};

/** Minimal glob match for the `asarUnpack` patterns (`**` and `*`). */
function matches(pattern: string, file: string): boolean {
  const source = pattern
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((text) => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${source}$`).test(file);
}

describe("electron-builder.json", () => {
  it("builds the per-user NSIS installer of TermDock without publishing anything", () => {
    expect(config.appId).toBe("io.github.playskyhd.termdock");
    expect(config.productName).toBe("TermDock");
    expect(config.artifactName).toBe("TermDock-Setup-${version}.${ext}");
    expect(config.win.target.map((t) => t.target)).toEqual(["nsis"]);
    expect(config.publish).toBeNull();
    expect(config.nsis).toMatchObject({
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      createStartMenuShortcut: true,
      deleteAppDataOnUninstall: false,
      include: "resources/installer.nsh",
    });
  });

  it("unpacks the core entry that the installed app starts, together with node-pty", () => {
    const resourcesPath = "C:\\Programs\\TermDock\\resources";
    const entry = coreEntryPath({ packaged: true, resourcesPath });
    const inApp = path
      .relative(path.join(resourcesPath, "app.asar.unpacked"), entry)
      .split(path.sep)
      .join("/");

    expect(config.asarUnpack.some((pattern) => matches(pattern, inApp))).toBe(true);
    expect(config.asarUnpack.some((pattern) => matches(pattern, "node_modules/node-pty/lib/index.js"))).toBe(
      true,
    );
    // node-pty brings N-API prebuilds; a rebuild from source fails on the host (agent-lessons-learned.md).
    expect(config.npmRebuild).toBe(false);
  });
});

describe("installer.nsh", () => {
  it("skips the choice of an installation for all users", () => {
    const script = readFileSync(path.join(desktop, "resources", "installer.nsh"), "utf8");

    expect(script).toMatch(/!macro customInstallMode\s+StrCpy \$isForceCurrentInstall "1"/);
    expect(script).toContain("%APPDATA%\\TermDock");
  });
});

describe("icon.ico", () => {
  it("holds the sizes from 16 to 256 px", () => {
    const ico = readFileSync(path.join(desktop, config.win.icon));
    expect(ico.readUInt16LE(2)).toBe(1); // icon, not cursor
    const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => ico[6 + 16 * index] || 256);

    expect(sizes).toEqual(expect.arrayContaining([16, 24, 32, 48, 64, 128, 256]));
  });
});

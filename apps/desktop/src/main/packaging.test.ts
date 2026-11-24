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

const packageJson = JSON.parse(readFileSync(path.join(desktop, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
};
const workflows = path.join(desktop, "..", "..", ".github", "workflows");

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
  it("builds the per-user NSIS installer of TermDock with update files, but uploads nothing (#136)", () => {
    expect(config.appId).toBe("io.github.playskyhd.termdock");
    expect(config.productName).toBe("TermDock");
    expect(config.artifactName).toBe("TermDock-Setup-${version}.${ext}");
    expect(config.win.target.map((t) => t.target)).toEqual(["nsis"]);
    // The target gives `latest.yml`, the blockmap and `app-update.yml`; drafts stay invisible to the updater.
    expect(config.publish).toEqual({
      provider: "github",
      owner: "PlaySkyHD",
      repo: "termdock",
      releaseType: "draft",
    });
    // Unsigned (ADR 0007): without a publisher name electron-updater checks no signature, only the SHA-512.
    expect(JSON.stringify(config)).not.toContain("publisherName");
    expect(packageJson.scripts.dist).toContain("--publish never");
    expect(packageJson.dependencies["electron-updater"]).toBe("6.8.11");
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

  it("leaves the test helpers of the core out of the app, but keeps its entry (issue #133)", () => {
    const excludes = config.files.filter((pattern) => pattern.startsWith("!")).map((p) => p.slice(1));
    // A leading `**/` also matches no directory at all, as in electron-builder.
    const excluded = (file: string) =>
      excludes.some((pattern) => matches(pattern, file) || matches(pattern, `app/${file}`));

    expect(excluded("node_modules/@termdock/core/dist/test/flooding-core.js")).toBe(true);
    expect(excluded("node_modules/@termdock/core/dist/test/wsl-socket.js")).toBe(true);
    expect(excluded("node_modules/@termdock/core/dist/bin/termdock-core.js")).toBe(false);
    expect(excluded("node_modules/@termdock/core/dist/index.js")).toBe(false);
  });
});

describe("installer.nsh", () => {
  it("skips the choice of an installation for all users", () => {
    const script = readFileSync(path.join(desktop, "resources", "installer.nsh"), "utf8");

    expect(script).toMatch(/!macro customInstallMode\s+StrCpy \$isForceCurrentInstall "1"/);
    expect(script).toContain("%APPDATA%\\TermDock");
  });

  it("says on both welcome pages that running WSL sessions keep running (issue #140)", () => {
    const script = readFileSync(path.join(desktop, "resources", "installer.nsh"), "utf8");
    const texts = [...script.matchAll(/MUI_WELCOMEPAGE_TEXT "([^"]*)"/g)].map((match) => match[1]!);

    expect(texts).toHaveLength(2);
    for (const text of texts) {
      expect(text).toContain("Laufende WSL-Sessions laufen weiter");
      expect(text).not.toContain("enden dabei in der Regel");
    }
  });
});

describe("release.yml (#136)", () => {
  const workflow = readFileSync(path.join(workflows, "release.yml"), "utf8");
  const ci = readFileSync(path.join(workflows, "ci.yml"), "utf8");

  it("runs only for a pushed tag v* and creates a draft, never a published release", () => {
    expect(workflow).toMatch(/on:\s+push:\s+tags:\s+- "v\*"/);
    expect(workflow).not.toMatch(/branches:|pull_request|workflow_dispatch/);
    expect(workflow).toContain("gh release create");
    expect(workflow).toContain("--draft");
    expect(workflow).not.toMatch(/--publish (always|onTag|onTagOrDraft)|gh release edit|--draft=false/);
  });

  it("uses no secret but GITHUB_TOKEN with the least permissions, and pins every action to a commit", () => {
    expect([...workflow.matchAll(/secrets\.(\w+)/g)].map((match) => match[1])).toEqual([]);
    expect(workflow).toMatch(/^permissions:\s+contents: read$/m);
    expect([...workflow.matchAll(/^\s+contents: (\w+)$/gm)].map((match) => match[1])).toEqual([
      "read",
      "read",
      "write",
    ]);
    expect(workflow).not.toMatch(/(packages|actions|id-token|pull-requests): write/);
    const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((match) => match[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) expect(action).toMatch(/@[0-9a-f]{40}$/);
    // The token only in the step that creates the release.
    expect(workflow.match(/github\.token/g)).toHaveLength(1);
  });

  it("checks the tag against the version, uploads installer, blockmap and latest.yml, and runs the smoke test", () => {
    expect(workflow).toContain("apps/desktop/package.json");
    expect(workflow).toContain("TAG: ${{ github.ref_name }}");
    // Tag and version reach the shell as variables, not as expressions in the script text.
    expect(workflow).not.toMatch(/run:[^\n]*\$\{\{/);
    expect(workflow).toContain("npm run dist -w apps/desktop");
    expect(workflow).toContain("--smoke-test");
    for (const file of ["TermDock-Setup-$VERSION.exe", "TermDock-Setup-$VERSION.exe.blockmap", "latest.yml"])
      expect(workflow).toContain(file);
  });

  it("builds with a read-only token kept out of git, and writes only in a job that runs no project code (review)", () => {
    const buildStart = workflow.indexOf("\n  build:\n");
    const draftStart = workflow.indexOf("\n  draft:\n");
    expect(buildStart).toBeGreaterThan(0);
    expect(draftStart).toBeGreaterThan(buildStart);
    const build = workflow.slice(buildStart, draftStart);
    const draft = workflow.slice(draftStart);

    // npm ci, electron-builder and the smoke test never see a writing token, nor one in the git config.
    expect(build).toMatch(/permissions:\s+contents: read/);
    expect(build).toMatch(
      /actions\/checkout@\S+[^\n]*\n\s+with:\n(\s+\S+:[^\n]*\n)*?\s+persist-credentials: false/,
    );
    expect(build).not.toContain("github.token");
    expect(build).not.toContain("gh release");
    // No npm cache on the release path (cache poisoning), and the tagged commit must be on main.
    expect(build).not.toMatch(/cache: npm/);
    expect(build).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(build).toContain("npm ci");

    // The writing job checks nothing out and runs no npm; it only uploads what the build left.
    expect(draft).toMatch(/needs: build/);
    expect(draft).toMatch(/permissions:\s+contents: write/);
    expect(draft).not.toMatch(/actions\/checkout|setup-node|npm /);
    expect(draft).toContain("actions/download-artifact@");
    expect(draft).toContain("gh release create");
    expect(draft).toContain("GH_REPO: ${{ github.repository }}");
  });

  it("lets the CI job package check the update files", () => {
    expect(ci).toContain("latest.yml");
    expect(ci).toContain(".blockmap");
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

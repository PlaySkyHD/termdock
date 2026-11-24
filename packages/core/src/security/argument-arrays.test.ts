// Security test (issue #135, spec wsl-backend "Befehle als Argument-Arrays"): every process the core or the desktop
// starts gets its program and arguments as an array. The test reads the TypeScript sources (no build needed, runs in
// CI) and fails on `exec`/`execSync`, on `shell` options other than `false`, on a program given as a composed string
// and on arguments given as a string. Exceptions go into ALLOWED with a reason.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
/** Production sources that may start processes; tests are not shipped and are left out. */
const ROOTS = ["packages/core/src", "apps/desktop/src"];

interface Finding {
  /** Path relative to the repo, with `/`. */
  file: string;
  line: number;
  rule: "exec" | "shell" | "composed-command" | "string-arguments" | "unchecked-use";
  text: string;
}

/** Findings that are accepted, each with its reason. Empty: nothing is accepted today. */
const ALLOWED: readonly { file: string; rule: Finding["rule"]; reason: string }[] = [];

const CHILD_PROCESS = new Set(["child_process", "node:child_process"]);
const FORBIDDEN = new Set(["exec", "execSync"]);

/** A call of a process API, as the scan saw it. */
interface CheckedCall {
  file: string;
  line: number;
  api: string;
}

interface ScanResult {
  findings: Finding[];
  calls: CheckedCall[];
}

/** Scans one source file. `file` is the path reported in findings. */
function scanSource(file: string, text: string): ScanResult {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const findings: Finding[] = [];
  const calls: CheckedCall[] = [];
  const lineOf = (node: ts.Node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const report = (node: ts.Node, rule: Finding["rule"]) =>
    findings.push({ file, line: lineOf(node), rule, text: node.getText(source).slice(0, 120) });

  /** Local name → API name (`spawn`, `execFile`, ...) of functions from child_process, and their aliases. */
  const functions = new Map<string, string>();
  /** Local names of the whole child_process or node-pty module. */
  const namespaces = new Map<string, "child_process" | "node-pty">();
  let usesNodePty = false;
  /** `const NAME = <initializer>` of the file, to follow a program or options given by name. */
  const constants = new Map<string, ts.Expression>();

  const unwrap = (expression: ts.Expression): ts.Expression => {
    let node = expression;
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
      node = node.expression;
    }
    return node;
  };
  /**
   * `cp.exec` or `cp["exec"]` on a namespace of child_process or node-pty. `name` is undefined for a name that is
   * not a literal (`cp[name]`).
   */
  const namespaceMember = (
    node: ts.Node,
  ): { kind: "child_process" | "node-pty"; name: string | undefined } | undefined => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const kind = namespaces.get(node.expression.text);
      return kind ? { kind, name: node.name.text } : undefined;
    }
    if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const kind = namespaces.get(node.expression.text);
      const key = node.argumentExpression;
      const literal = ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key);
      return kind ? { kind, name: literal ? key.text : undefined } : undefined;
    }
    return undefined;
  };

  const visitAll = (visit: (node: ts.Node) => void) => {
    const walk = (node: ts.Node): void => {
      visit(node);
      ts.forEachChild(node, walk);
    };
    walk(source);
  };

  visitAll((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (!clause || clause.isTypeOnly) return;
      if (CHILD_PROCESS.has(module) || module === "node-pty") {
        const kind = module === "node-pty" ? "node-pty" : "child_process";
        if (kind === "node-pty") usesNodePty = true;
        if (clause.name) namespaces.set(clause.name.text, kind);
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, kind);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            if (element.isTypeOnly) continue;
            const imported = (element.propertyName ?? element.name).text;
            functions.set(element.name.text, kind === "node-pty" ? `node-pty ${imported}` : imported);
          }
        }
      }
    }
    // `import("node-pty")`, `import("node:child_process")`, `require(...)`.
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]!)) {
      const module = node.arguments[0].text;
      const dynamic =
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require");
      if (dynamic && module === "node-pty") usesNodePty = true;
      // Bindings of a dynamic child_process import are not followed: it must be allowed explicitly.
      if (dynamic && CHILD_PROCESS.has(module)) report(node, "unchecked-use");
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      constants.set(node.name.text, node.initializer);
    }
    if (ts.isVariableDeclaration(node) && node.initializer) {
      const init = unwrap(node.initializer);
      // `const { exec, spawn: run } = cp`: the members become tracked functions.
      if (ts.isObjectBindingPattern(node.name) && ts.isIdentifier(init) && namespaces.has(init.text)) {
        const kind = namespaces.get(init.text)!;
        for (const element of node.name.elements) {
          let imported: ts.Node = element.propertyName ?? element.name;
          // `{ ["exec"]: run }`
          if (
            ts.isComputedPropertyName(imported) &&
            (ts.isStringLiteral(imported.expression) ||
              ts.isNoSubstitutionTemplateLiteral(imported.expression))
          ) {
            imported = imported.expression;
          }
          const name =
            !element.dotDotDotToken &&
            ts.isIdentifier(element.name) &&
            (ts.isIdentifier(imported) ||
              ts.isStringLiteral(imported) ||
              ts.isNoSubstitutionTemplateLiteral(imported))
              ? imported.text
              : undefined;
          // A rest element, a nested pattern or a computed name cannot be followed.
          if (name === undefined) report(element, "unchecked-use");
          else
            functions.set(
              (element.name as ts.Identifier).text,
              kind === "node-pty" ? `node-pty ${name}` : name,
            );
        }
      }
      // `const run = cp.exec`, `const run = cp["exec"]`.
      if (ts.isIdentifier(node.name)) {
        const member = namespaceMember(init);
        if (member?.name !== undefined) {
          functions.set(node.name.text, member.kind === "node-pty" ? `node-pty ${member.name}` : member.name);
        }
      }
    }
  });

  const isInType = (node: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
      if (ts.isTypeQueryNode(current) || ts.isTypeReferenceNode(current)) return true;
    }
    return false;
  };
  const isCallee = (node: ts.Identifier) =>
    ts.isCallExpression(node.parent) && node.parent.expression === node;
  /** The name of a tracked function used as a value: not a property name (`options.spawn`) and not in a type. */
  const usesFunction = (node: ts.Node): node is ts.Identifier => {
    if (!ts.isIdentifier(node) || !functions.has(node.text) || isCallee(node) || isInType(node)) return false;
    const parent = node.parent;
    const isName =
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      ((ts.isPropertyAssignment(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isPropertyDeclaration(parent) ||
        ts.isMethodDeclaration(parent) ||
        ts.isMethodSignature(parent)) &&
        parent.name === node) ||
      (ts.isImportSpecifier(parent) && parent.propertyName === node);
    return !isName;
  };
  /** API name of a value reference to a tracked function in `expression`, if any (not as callee). */
  const referencedApi = (expression: ts.Node): string | undefined => {
    let api: string | undefined;
    const walk = (node: ts.Node): void => {
      if (api) return;
      if (usesFunction(node)) api = functions.get(node.text);
      ts.forEachChild(node, walk);
    };
    walk(expression);
    return api;
  };

  // Aliases: `const run = promisify(execFile)`, `spawn = options.spawn ?? nodeSpawn`, `fn = execFile as Fn`.
  for (let changed = true; changed;) {
    changed = false;
    visitAll((node) => {
      if (!(ts.isVariableDeclaration(node) || ts.isParameter(node))) return;
      if (!ts.isIdentifier(node.name) || !node.initializer || functions.has(node.name.text)) return;
      const api = referencedApi(node.initializer);
      if (api) {
        functions.set(node.name.text, api);
        changed = true;
      }
    });
  }

  /** True when `expression` is a string put together at run time (template, `+`, a call such as `join`). */
  const composed = (expression: ts.Expression, seen = new Set<string>()): boolean => {
    let node = expression;
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
      node = node.expression;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return /\s/.test(node.text);
    if (ts.isTemplateExpression(node) || ts.isCallExpression(node)) return true;
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) return true;
      return composed(node.left, seen) || composed(node.right, seen);
    }
    if (ts.isConditionalExpression(node))
      return composed(node.whenTrue, seen) || composed(node.whenFalse, seen);
    if (ts.isIdentifier(node) && constants.has(node.text) && !seen.has(node.text)) {
      seen.add(node.text);
      return composed(constants.get(node.text)!, seen);
    }
    // A name or property from elsewhere (`options.execPath`): a path, not built here.
    return false;
  };
  const isStringish = (node: ts.Expression) =>
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node) ||
    (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken);
  /** An options object with `shell` set to anything but `false`; follows a `const` of the file. */
  const shellOption = (expression: ts.Expression): ts.Node | undefined => {
    const target =
      ts.isIdentifier(expression) && constants.has(expression.text)
        ? constants.get(expression.text)!
        : expression;
    if (!ts.isObjectLiteralExpression(target)) return undefined;
    return target.properties.find((property) => {
      const name = property.name && ts.isIdentifier(property.name) ? property.name.text : undefined;
      if (name !== "shell") return false;
      return !(ts.isPropertyAssignment(property) && property.initializer.kind === ts.SyntaxKind.FalseKeyword);
    });
  };

  const check = (call: ts.CallExpression, api: string) => {
    calls.push({ file, line: lineOf(call), api });
    if (FORBIDDEN.has(api)) {
      report(call, "exec");
      return;
    }
    const [program, args] = call.arguments;
    if (program && composed(program)) report(program, "composed-command");
    if (args && isStringish(args)) report(args, "string-arguments");
    for (const argument of call.arguments) {
      const shell = shellOption(argument);
      if (shell) report(shell, "shell");
    }
  };

  visitAll((node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && functions.has(callee.text)) check(node, functions.get(callee.text)!);
      if (ts.isPropertyAccessExpression(callee)) {
        const owner = callee.expression;
        const kind = ts.isIdentifier(owner) ? namespaces.get(owner.text) : undefined;
        if (kind === "child_process") check(node, callee.name.text);
        // node-pty is loaded on first use (`const pty = await import("node-pty")`): every `<x>.spawn` of a file
        // that loads it counts, except `this.spawn`.
        else if (
          callee.name.text === "spawn" &&
          (kind === "node-pty" || (usesNodePty && owner.kind !== ts.SyntaxKind.ThisKeyword))
        ) {
          check(node, "node-pty spawn");
        }
      }
      // `cp["exec"](...)`; a name that is not a literal cannot be followed.
      if (ts.isElementAccessExpression(callee)) {
        const member = namespaceMember(callee);
        if (member?.name === undefined) {
          if (member) report(callee, "unchecked-use");
        } else if (member.kind === "child_process") check(node, member.name);
        else if (member.name === "spawn") check(node, "node-pty spawn");
      }
    }
    // A member of the namespace handed on as a value (`register(cp.exec)`) escapes the checks; naming it in a
    // `const` is followed above.
    const member = namespaceMember(node);
    // Every child_process member counts; of node-pty only `spawn` (or a name that is not a literal).
    if (
      member &&
      !isInType(node) &&
      (member.kind === "child_process" || member.name === "spawn" || member.name === undefined)
    ) {
      const parent = node.parent;
      const callee = ts.isCallExpression(parent) && parent.expression === node;
      const named =
        member.name !== undefined &&
        ts.isVariableDeclaration(parent) &&
        parent.initializer === node &&
        ts.isIdentifier(parent.name);
      if (!callee && !named) report(node, "unchecked-use");
    }
    // A tracked function handed on in another way (an argument, a property) escapes the checks above.
    if (usesFunction(node)) {
      const parent = node.parent;
      const declaration =
        ts.isImportSpecifier(parent) ||
        (ts.isBindingElement(parent) && parent.name === node) ||
        ((ts.isVariableDeclaration(parent) || ts.isParameter(parent)) && parent.name === node);
      let inAlias = false;
      for (let current: ts.Node | undefined = parent; current; current = current.parent) {
        if ((ts.isVariableDeclaration(current) || ts.isParameter(current)) && current.initializer) {
          if (ts.isIdentifier(current.name) && functions.has(current.name.text)) inAlias = true;
          break;
        }
      }
      if (!declaration && !inAlias) report(node, "unchecked-use");
    }
  });
  return { findings, calls };
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(full));
    else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.test\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      files.push(full);
    }
  }
  return files;
}

function scanRepo(): ScanResult {
  const result: ScanResult = { findings: [], calls: [] };
  for (const root of ROOTS) {
    for (const file of sourceFiles(path.join(REPO, root))) {
      const relative = path.relative(REPO, file).split(path.sep).join("/");
      const { findings, calls } = scanSource(relative, readFileSync(file, "utf8"));
      result.findings.push(...findings);
      result.calls.push(...calls);
    }
  }
  return result;
}

const rules = (text: string) => scanSource("fixture.ts", text).findings.map((finding) => finding.rule);

describe("process calls use argument arrays (issue #135)", () => {
  it("finds no exec, no shell option and no composed command in core and desktop", () => {
    const { findings, calls } = scanRepo();
    const open = findings.filter(
      (finding) => !ALLOWED.some((allowed) => allowed.file === finding.file && allowed.rule === finding.rule),
    );
    expect(open).toEqual([]);
    // The scan sees the real calls; without them it would pass on nothing.
    const seen = calls.map((call) => `${call.file} ${call.api}`);
    expect(seen).toEqual(
      expect.arrayContaining([
        "packages/core/src/backend/wsl/processes.ts execFile",
        "packages/core/src/backend/wsl/processes.ts spawn",
        "packages/core/src/backend/conpty/spawn.ts node-pty spawn",
        "apps/desktop/src/main/core-process.ts spawn",
        "apps/desktop/src/main/screenshot.ts execFile",
        "apps/desktop/src/main/screenshot-scenario.ts execFile",
      ]),
    );
  });

  it("every allowed exception still matches a finding and has a reason", () => {
    const { findings } = scanRepo();
    for (const allowed of ALLOWED) {
      expect(allowed.reason.length, allowed.file).toBeGreaterThan(10);
      expect(
        findings.some((f) => f.file === allowed.file && f.rule === allowed.rule),
        allowed.file,
      ).toBe(true);
    }
  });

  it("accepts a fixed program with an argument array", () => {
    const ok = `
      import { execFile, spawn } from "node:child_process";
      const WSL = "wsl.exe";
      export const a = (args: string[]) => execFile(WSL, [...args], { windowsHide: true }, () => {});
      export const b = (exe: { path: string }) => spawn(exe.path, ["--x"], { shell: false, stdio: "ignore" });
    `;
    expect(scanSource("fixture.ts", ok)).toEqual({
      findings: [],
      calls: [
        { file: "fixture.ts", line: 4, api: "execFile" },
        { file: "fixture.ts", line: 5, api: "spawn" },
      ],
    });
  });

  it("rejects exec and execSync, also through a namespace or an alias", () => {
    expect(rules(`import { exec } from "child_process"; exec("ls");`)).toEqual(["exec"]);
    expect(rules(`import * as cp from "node:child_process"; cp.execSync("ls");`)).toEqual(["exec"]);
    expect(
      rules(`import { exec } from "node:child_process"; import { promisify } from "node:util";
        const run = promisify(exec); run("ls");`),
    ).toEqual(["exec"]);
  });

  it("rejects exec through a namespace alias: destructuring, a member in a const, an element access", () => {
    const head = `import * as cp from "node:child_process"; `;
    const cases = [
      'const { exec } = cp; exec("ls");',
      'const { exec: run } = cp; run("ls");',
      'const { ["exec"]: run } = cp; run("ls");',
      'const run = cp.exec; run("ls");',
      'const run = cp["exec"]; run("ls");',
      'cp["exec"]("ls");',
      "cp[`execSync`]('ls');",
      'const { execSync } = cp as typeof import("node:child_process"); execSync("ls");',
    ];
    for (const body of cases) {
      expect(rules(head + body), body).toContain("exec");
    }
  });

  it("checks the other members taken from a namespace like the imported ones", () => {
    const head = `import * as cp from "node:child_process"; `;
    expect(rules(head + 'const { spawn } = cp; spawn("a", [], { shell: true });')).toEqual(["shell"]);
    expect(rules(head + 'cp["spawn"]("wsl.exe -d x", []);')).toEqual(["composed-command"]);
    expect(rules(head + 'const run = cp.execFile; run("wsl.exe", ["-d", d]);')).toEqual([]);
    expect(scanSource("fixture.ts", head + 'const { spawn: go } = cp; go("a", []);').calls).toEqual([
      { file: "fixture.ts", line: 1, api: "spawn" },
    ]);
  });

  it("reports a namespace member it cannot follow", () => {
    const head = `import * as cp from "node:child_process"; `;
    for (const body of [
      "register(cp.spawn);",
      "const name = pick(); cp[name]('ls');",
      "const { spawn, ...rest } = cp;",
      "const { [key]: run } = cp;",
    ]) {
      expect(rules(head + body), body).toContain("unchecked-use");
    }
    expect(rules(head + "let c: cp.ChildProcess; let t: typeof cp.spawn;")).toEqual([]);
  });

  it("rejects a shell option, also from a constant", () => {
    expect(rules(`import { spawn } from "node:child_process"; spawn("a", [], { shell: true });`)).toEqual([
      "shell",
    ]);
    expect(
      rules(
        `import { execFile } from "node:child_process"; const o = { shell: "bash" }; execFile("a", [], o);`,
      ),
    ).toEqual(["shell"]);
  });

  it("rejects a program put together from parts or with arguments inside", () => {
    const cases = [
      "spawn(`wsl.exe -d ${distro}`, []);",
      'spawn("wsl.exe " + distro, []);',
      'spawn(["wsl.exe", distro].join(" "), []);',
      'spawn("wsl.exe -d Ubuntu", []);',
      "const CMD = `tmux ${socket}`; spawn(CMD, []);",
    ];
    for (const body of cases) {
      expect(rules(`import { spawn } from "node:child_process"; ${body}`), body).toEqual([
        "composed-command",
      ]);
    }
  });

  it("rejects arguments given as one string", () => {
    expect(rules(`import { execFile } from "node:child_process"; execFile("wsl.exe", "-d " + d);`)).toEqual([
      "string-arguments",
    ]);
  });

  it("checks node-pty spawn, also when node-pty is loaded on first use", () => {
    const lazy = `
      let mod: Promise<typeof import("node-pty")> | undefined;
      export async function start(cmd: string) {
        mod ??= import("node-pty");
        const pty = await mod;
        return pty.spawn(\`wsl.exe \${cmd}\`, [], {});
      }
    `;
    expect(rules(lazy)).toEqual(["composed-command"]);
    expect(rules(`import * as pty from "node-pty"; pty.spawn("wsl.exe", [], { shell: true });`)).toEqual([
      "shell",
    ]);
  });

  it("reports a process function handed on unchecked and a dynamic child_process import", () => {
    expect(rules(`import { spawn } from "node:child_process"; register(spawn);`)).toEqual(["unchecked-use"]);
    expect(rules(`const cp = require("child_process");`)).toEqual(["unchecked-use"]);
    expect(rules(`import type { SpawnOptions } from "node:child_process"; let o: SpawnOptions;`)).toEqual([]);
  });
});

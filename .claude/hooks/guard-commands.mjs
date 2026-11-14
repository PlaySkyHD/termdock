// PreToolUse hook for Bash and PowerShell: blocks commands that agents must not run (issue #43).
// The rules and their reasons are listed in docs/agent-lessons-learned.md, section 5.
//
// Input: hook JSON on stdin (`tool_name`, `tool_input.command`). A hit exits with 2 and a German reason
// plus the allowed alternative on stderr; everything else exits with 0. Invalid input or an internal
// error also exits with 0: a broken hook must never block the work.
//
// Detection: the command is split into words, redirects and heredoc bodies with a small shell lexer
// (Bash or PowerShell quoting). Only the command word of each segment is inspected, so text in quotes,
// commit messages, heredoc bodies and comments does not match. `bash -c`, `powershell -Command` and
// `wsl.exe [-- | --exec]` are checked recursively. Relative paths count as repository paths if the
// working directory (`cwd` of the event, after any `cd` in the command; a `cd` inside `( … )` stays
// inside) is in the repository, or if the event has no `cwd`. A command the lexer cannot split cleanly
// (unbalanced `$(`) is allowed. The guard prefers missing a case over a false alarm.
//
// Known gaps (not detected):
// - writes through other programs: `cp`, `mv`, `dd`, `truncate`, `git apply`, `git checkout -- <file>`,
//   `git clean`, `awk -i inplace`, `py`, script files (`node x.mjs`, `bash x.sh`), `cmd /c`;
// - commands that are not the command word: `xargs sed -i`, `find -exec sed -i`, `Start-Process wsl`,
//   `powershell -EncodedCommand`, git aliases, tmux command aliases, `pkill tmux`;
// - paths from variables or command substitution (`> "$f"`, `$(...)`, backticks): a path that starts
//   with `$` counts as outside the repository, and substitutions are not inspected;
// - `node -e` and `[IO.File]::Write*` look only at string literals: one absolute path outside the
//   repository allows the command even if it also writes a relative path.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EDIT_HINT =
  "Dateien mit Read/Edit/Write ändern; Formatter (`npm run format`) und Generatoren dürfen schreiben, temporäre Dateien gehören nach P:/Temp/.";

function block(reason, alternative) {
  return { reason, alternative };
}

function writeBlock(what, path) {
  return block(`${what} schreibt in eine Datei im Repo-Checkout (${path}).`, EDIT_HINT);
}

// ---------------------------------------------------------------------------------------------------
// Paths

function normalize(path) {
  return path
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .toLowerCase();
}

function isRepoAbsolute(path) {
  return /^(?:p:|\/p|\/mnt\/p)\/github\/termdock/.test(normalize(path));
}

function isAbsolute(path) {
  return /^(?:[a-z]:|[/\\~$%])/i.test(path);
}

function isNullDevice(path) {
  const p = normalize(path);
  return p === "" || p === "-" || p === "nul" || p === "$null" || p.startsWith("/dev/");
}

function isRepoPath(path, ctx) {
  if (isRepoAbsolute(path)) return true;
  if (isNullDevice(path) || isAbsolute(path)) return false;
  return ctx.cwdInRepo;
}

// For inline code (`node -e`, `[IO.File]::WriteAllText`): look at the string literals.
function codeWritesToRepo(code, ctx) {
  const literals = [...code.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]);
  if (literals.some(isRepoAbsolute)) return true;
  if (literals.some((l) => isAbsolute(l) && !isNullDevice(l))) return false;
  return ctx.cwdInRepo;
}

// ---------------------------------------------------------------------------------------------------
// Lexer: splits a command into segments { words, redirects, heredocs }.

// A command the lexer cannot split cleanly (e.g. an unbalanced `$(`): rather allow than block.
class Unparseable extends Error {}

function newSegment() {
  return { words: [], redirects: [], heredocs: [], test: false };
}

function parse(src, dialect) {
  const ps = dialect === "ps";
  const esc = ps ? "`" : "\\";
  const segments = [];
  let seg = newSegment();
  let word = null;
  let pending = null; // "redirect" | "input" | "heredoc": what the next word is
  let heredocStrip = false;
  let heredocQueue = [];
  let i = 0;

  const startWord = () => {
    if (word === null) word = { text: "", quoted: false };
  };
  const endWord = () => {
    if (word === null) return;
    const w = word;
    word = null;
    if (pending === "redirect") seg.redirects.push(w.text);
    else if (pending === "heredoc") heredocQueue.push({ delim: w.text, strip: heredocStrip, seg });
    else if (pending !== "input") {
      seg.words.push(w.text);
      if (!ps && !w.quoted && w.text === "[[") seg.test = true;
      if (!ps && !w.quoted && w.text === "]]") seg.test = false;
    }
    pending = null;
  };
  const endSegment = () => {
    endWord();
    pending = null;
    if (seg.words.length || seg.redirects.length) segments.push(seg);
    seg = newSegment();
  };
  const isFdWord = () => word !== null && !word.quoted && /^(?:\d+|\*)$/.test(word.text);

  // Copies `$( … )` into the current word without inspecting it. Quotes and heredoc bodies inside count
  // as data. Throws Unparseable if the end cannot be found cleanly.
  const readBalanced = (start) => {
    // src[start] is "$", src[start + 1] is "(".
    let depth = 0;
    let heredocs = [];
    let j = start + 1;
    for (; j < src.length; j++) {
      const ch = src[j];
      if (ch === "(") depth++;
      else if (ch === ")") {
        if (--depth === 0) break;
      } else if (ch === esc) j++;
      else if (ch === "'") {
        const close = src.indexOf("'", j + 1);
        if (close === -1) throw new Unparseable();
        j = close;
      } else if (ch === '"') {
        let k = j + 1;
        while (k < src.length && src[k] !== '"') k += src[k] === esc ? 2 : 1;
        if (k >= src.length) throw new Unparseable();
        j = k;
      } else if (!ps && src.startsWith("<<", j) && src[j + 2] !== "<") {
        const m = /^<<(-?)[ \t]*(['"]?)([\w.-]+)\2/.exec(src.slice(j));
        if (m) {
          heredocs.push({ delim: m[3], strip: m[1] === "-" });
          j += m[0].length - 1;
        }
      } else if (ch === "\n" && heredocs.length) {
        let k = j + 1;
        for (const h of heredocs) {
          for (;;) {
            if (k >= src.length) throw new Unparseable();
            let end = src.indexOf("\n", k);
            if (end === -1) end = src.length;
            const line = src.slice(k, end).replace(/\r$/, "");
            k = end + 1;
            if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
          }
        }
        heredocs = [];
        j = k - 1;
      }
    }
    if (j >= src.length) throw new Unparseable();
    word.text += src.slice(start, j + 1);
    return j + 1;
  };

  const readHeredocs = (start) => {
    let j = start;
    for (const h of heredocQueue) {
      const lines = [];
      while (j < src.length) {
        let end = src.indexOf("\n", j);
        if (end === -1) end = src.length;
        const line = src.slice(j, end).replace(/\r$/, "");
        j = end + 1;
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) break;
        lines.push(line);
      }
      h.seg.heredocs.push(lines.join("\n"));
    }
    heredocQueue = [];
    return j;
  };

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === "\n") {
      endSegment();
      i++;
      if (heredocQueue.length) i = readHeredocs(i);
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
      continue;
    }
    if (c === esc) {
      if (next === "\n") i += 2;
      else if (next === "\r" && src[i + 2] === "\n") i += 3;
      else {
        startWord();
        word.text += next ?? "";
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      startWord();
      word.quoted = true;
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] !== "'") word.text += src[j];
        else if (ps && src[j + 1] === "'") word.text += src[j++];
        else break;
      }
      i = j + 1;
      continue;
    }
    if (c === '"') {
      startWord();
      word.quoted = true;
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === esc) {
          const n = src[j + 1] ?? "";
          word.text += ps || '$`"\\\n'.includes(n) ? n : esc + n;
          j += 2;
        } else if (src[j] === "$" && src[j + 1] === "(") j = readBalanced(j);
        else word.text += src[j++];
        if (ps && src[j] === '"' && src[j + 1] === '"') {
          word.text += '"';
          j += 2;
        }
      }
      i = j + 1;
      continue;
    }
    if (ps && c === "@" && word === null && (next === "'" || next === '"')) {
      const m = /^[ \t]*\r?\n/.exec(src.slice(i + 2));
      if (m) {
        const bodyStart = i + 2 + m[0].length;
        let end = src.indexOf(`\n${next}@`, bodyStart - 1);
        if (end === -1) end = src.length;
        startWord();
        word.quoted = true;
        word.text = src.slice(bodyStart, Math.max(bodyStart, end)).replace(/\r$/, "");
        i = end + 3;
        continue;
      }
    }
    if (c === "$" && next === "(") {
      startWord();
      i = readBalanced(i);
      continue;
    }
    if (!ps && c === "`") {
      startWord();
      const close = src.indexOf("`", i + 1);
      const end = close === -1 ? src.length : close + 1;
      word.text += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === "#" && word === null) {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (seg.test && (c === ">" || c === "<")) {
      startWord();
      word.text += c;
      i++;
      continue;
    }
    if (c === ">") {
      if (isFdWord()) word = null;
      else endWord();
      i++;
      if (src[i] === ">" || (!ps && src[i] === "|")) i++;
      if (src[i] === "&") {
        i++;
        while (i < src.length && /[\d-]/.test(src[i])) i++;
        continue;
      }
      pending = "redirect";
      continue;
    }
    if (c === "<") {
      if (isFdWord()) word = null;
      else endWord();
      if (src.startsWith("<<<", i)) {
        i += 3;
        pending = "input";
      } else if (src.startsWith("<<", i)) {
        i += 2;
        heredocStrip = src[i] === "-";
        if (heredocStrip) i++;
        pending = "heredoc";
      } else {
        i++;
        pending = "input";
      }
      continue;
    }
    if (c === "&") {
      if (next === "&") {
        endSegment();
        i += 2;
      } else if (!ps && next === ">") {
        endWord();
        i += src[i + 2] === ">" ? 3 : 2;
        pending = "redirect";
      } else if (ps) {
        endWord();
        seg.words.push("&");
        i++;
      } else {
        endSegment();
        i++;
      }
      continue;
    }
    if (!ps && c === "(" && next === "(" && word === null) {
      // Arithmetic `(( a > b ))`: no command, no redirect.
      endSegment();
      const close = src.indexOf("))", i + 2);
      i = close === -1 ? src.length : close + 2;
      continue;
    }
    if (c === "|" || c === ";" || c === "(" || c === ")" || (ps && (c === "{" || c === "}"))) {
      endSegment();
      // Markers so that a `cd` inside `( … )` does not leak out.
      if (c === "(") segments.push({ scope: "open" });
      if (c === ")") segments.push({ scope: "close" });
      i += c === "|" && next === "|" ? 2 : 1;
      continue;
    }
    startWord();
    word.text += c;
    i++;
  }
  endSegment();
  return segments;
}

// ---------------------------------------------------------------------------------------------------
// Rules per command word

const PREFIX_WORDS = new Set([
  "sudo",
  "env",
  "command",
  "exec",
  "nohup",
  "time",
  "nice",
  "&",
  "{",
  "}",
  "!",
  "if",
  "then",
  "elif",
  "else",
  "do",
  "while",
  "until",
]);

function commandName(word) {
  return word
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .toLowerCase()
    .replace(/\.exe$/, "");
}

function stripPrefixes(words, ps) {
  let w = words;
  while (w.length) {
    if (ps && w[0].startsWith("$") && w[1] === "=") w = w.slice(2);
    else if (!ps && /^[A-Za-z_]\w*=/.test(w[0])) w = w.slice(1);
    else if (PREFIX_WORDS.has(commandName(w[0]))) w = w.slice(1);
    else break;
  }
  return w;
}

function checkGit(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    const takesValue = ["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(
      args[i],
    );
    i += takesValue ? 2 : 1;
  }
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === "restore")
    return block(
      "`git restore` verwirft Änderungen ohne Rückweg.",
      "Dateien per Edit zurücksetzen; zum Entstagen `git reset -- <datei>`.",
    );
  if (sub === "stash")
    return block(
      "`git stash` versteckt Änderungen, sie gehen zwischen Worktrees leicht verloren.",
      "Änderungen committen oder einen eigenen Worktree anlegen.",
    );
  // git accepts unique abbreviations such as `--har`.
  if (sub === "reset" && rest.some((a) => a.length >= 3 && "--hard".startsWith(a)))
    return block(
      "`git reset --hard` verwirft Änderungen ohne Rückweg.",
      "`git reset --soft <ref>` oder ein neuer Commit, der die Änderung zurücknimmt.",
    );
  return null;
}

function checkTmux(args) {
  let socket = null;
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    const a = args[i];
    if (a === "-L" || a === "-S") {
      socket = commandName(args[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (a.startsWith("-L") || a.startsWith("-S")) socket = commandName(a.slice(2));
    i += a === "-f" || a === "-T" || a === "-c" ? 2 : 1;
  }
  const killsServer = args.slice(i).some((t) => t.length >= 8 && "kill-server".startsWith(t.toLowerCase()));
  if (killsServer && (socket === null || socket === "termdock" || socket === "default"))
    return block(
      "`tmux kill-server` auf dem Socket `termdock` oder dem Standard-Socket beendet den produktiven tmux-Server samt aller Sessions.",
      "Eigene Sessions mit `kill-session -t <name>` aufräumen; Tests nutzen `-L termdock-test…`.",
    );
  return null;
}

function checkWsl(args, ctx) {
  const withValue = ["-d", "--distribution", "-u", "--user", "--cd", "--shell-type", "--distribution-id"];
  for (let i = 0; i < args.length; i++) {
    const a = args[i].toLowerCase();
    if (a === "--shutdown" || a === "--terminate" || a === "-t")
      return block(
        "`wsl --shutdown`/`--terminate` beendet die Distro und damit den produktiven tmux-Server samt aller Sessions.",
        "Bei WSL-Fehlern stoppen und dem Orchestrator berichten.",
      );
    if (a === "--exec" || a === "-e") return checkWords(args.slice(i + 1), { ...ctx }, "bash", []);
    if (a === "--") return checkArgv(args.slice(i + 1), "bash", ctx);
    if (withValue.includes(a)) i++;
    else if (!a.startsWith("-")) return checkArgv(args.slice(i), "bash", ctx);
  }
  return null;
}

// A command passed on as arguments (`wsl -- …`, `powershell -Command …`). The words are already split
// with their quoting; only a single argument is parsed again as a command line (`wsl -- "a; b"`).
function checkArgv(argv, dialect, ctx) {
  if (argv.length === 1) return checkSource(argv[0], dialect, { ...ctx });
  return checkWords(argv, { ...ctx }, dialect, []);
}

function checkShell(args, ctx) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-[a-z]*c[a-z]*$/.test(a)) return args[i + 1] ? checkSource(args[i + 1], "bash", { ...ctx }) : null;
    if (!a.startsWith("-")) return null;
  }
  return null;
}

function checkPowerShell(args, ctx) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i].toLowerCase();
    if (a === "-c" || (a.length >= 4 && "-command".startsWith(a)))
      return checkArgv(args.slice(i + 1), "ps", ctx);
  }
  return null;
}

// sed and perl: an in-place option (`-i`, `-i.bak`, `-pi`, `--in-place`) on a file in the repository.
function checkInPlace(name, args, ctx) {
  let inPlace = false;
  let hasScript = false;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (a === "--in-place" || a.startsWith("--in-place=")) inPlace = true;
    else if (a === "--expression" || a === "--file") {
      hasScript = true;
      i++;
    } else if (a.startsWith("--expression=") || a.startsWith("--file=")) hasScript = true;
    else if (/^-[^-]/.test(a)) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (name === "perl" && "MmIxFdDC".includes(c)) {
          // Options with an attached value (`-MFile::Spec`, `-Ilib`): the rest is not a cluster.
          if (j === a.length - 1 && "MmI".includes(c)) i++;
          break;
        }
        if (name === "perl" && (c === "l" || c === "0")) {
          // Optional octal (or `-0x` hex) value, then the cluster continues (`-lpi`).
          const value = c === "0" ? /^(?:[xX][0-9a-fA-F]*|[0-7]*)/ : /^[0-7]*/;
          j += value.exec(a.slice(j + 1))[0].length;
          continue;
        }
        if (c === "i") {
          inPlace = true;
          break;
        }
        if (c === "e" || c === "E" || (name === "sed" && c === "f")) {
          if (name === "sed" && c === "E") continue;
          hasScript = true;
          if (j === a.length - 1) i++;
          break;
        }
      }
    } else positional.push(a);
  }
  if (!inPlace) return null;
  const files = hasScript ? positional : positional.slice(1);
  const target = files.find((f) => isRepoPath(f, ctx));
  return target === undefined ? null : writeBlock(`\`${name} -i\``, target);
}

const WRITE_API =
  /\b(?:write|append)File(?:Sync)?\b|\bcreateWriteStream\b|\bfs(?:\.promises)?\.write|\bwriteSync\b/;

function checkNode(args, heredocs, ctx) {
  let code = null;
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (["-e", "--eval", "-p", "--print", "-pe", "-ep"].includes(a)) {
      code = args[i + 1] ?? "";
      break;
    }
    if (a.startsWith("--eval=") || a.startsWith("--print=")) {
      code = a.slice(a.indexOf("=") + 1);
      break;
    }
    if (a === "-") {
      code = heredocs.join("\n");
      break;
    }
    if (!a.startsWith("-")) return null;
    if (["-r", "--require", "--import", "--loader"].includes(a)) i++;
  }
  if (code === null && i >= args.length) code = heredocs.join("\n");
  if (code && WRITE_API.test(code) && codeWritesToRepo(code, ctx))
    return block(
      "Inline-Node-Code (`node -e`/`-p`/Heredoc) schreibt eine Datei im Repo-Checkout.",
      EDIT_HINT,
    );
  return null;
}

function checkTee(args, ctx) {
  const target = args.find((a) => !a.startsWith("-") && isRepoPath(a, ctx));
  return target === undefined ? null : writeBlock("`tee`", target);
}

const PS_WRITERS = new Set(["set-content", "add-content", "out-file", "tee-object"]);
// Aliases count only in PowerShell and only as written (`sc.exe` is the service control tool).
const PS_WRITER_ALIASES = new Set(["sc", "ac"]);
const PS_SWITCHES = new Set([
  "-append",
  "-force",
  "-noclobber",
  "-nonewline",
  "-passthru",
  "-whatif",
  "-confirm",
  "-asbytestream",
]);

function checkPsWriter(name, args, ctx) {
  let path = null;
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = /^-(?:path|literalpath|filepath|pspath|lp)(?::(.*))?$/i.exec(a);
    if (m) path = m[1] ?? args[++i] ?? null;
    else if (a.startsWith("-") && a.length > 1) {
      if (!PS_SWITCHES.has(a.toLowerCase().replace(/:.*$/, "")) && !a.includes(":")) i++;
    } else positional.push(a);
  }
  path ??= positional[0];
  return path && isRepoPath(path, ctx) ? writeBlock(`\`${name}\``, path) : null;
}

function checkWords(words, ctx, dialect, heredocs) {
  const w = stripPrefixes(words, dialect === "ps");
  if (!w.length) return null;
  const name = commandName(w[0]);
  const args = w.slice(1);
  switch (name) {
    case "cd":
    case "pushd":
    case "chdir":
    case "set-location":
    case "sl": {
      const dir = args.find((a) => !a.startsWith("-"));
      ctx.cwdInRepo = dir === undefined ? false : isRepoPath(dir, ctx);
      return null;
    }
    case "git":
      return checkGit(args);
    case "tmux":
      return checkTmux(args);
    case "wsl":
      return checkWsl(args, ctx);
    case "bash":
    case "sh":
    case "zsh":
    case "dash":
      return checkShell(args, ctx);
    case "powershell":
    case "pwsh":
      return checkPowerShell(args, ctx);
    case "sed":
    case "perl":
      return checkInPlace(name, args, ctx);
    case "node":
      return checkNode(args, heredocs, ctx);
    case "tee":
      return checkTee(args, ctx);
    default:
      if (PS_WRITERS.has(name) || (dialect === "ps" && PS_WRITER_ALIASES.has(w[0].toLowerCase())))
        return checkPsWriter(w[0], args, ctx);
      return null;
  }
}

function checkSource(src, dialect, ctx) {
  if (
    dialect === "ps" &&
    /\[(?:system\.)?io\.file\]::(?:write|append)all/i.test(src) &&
    codeWritesToRepo(src, ctx)
  )
    return block("`[IO.File]::Write…`/`Append…` schreibt eine Datei im Repo-Checkout.", EDIT_HINT);
  const outer = [];
  for (const seg of parse(src, dialect)) {
    if (seg.scope === "open") outer.push(ctx.cwdInRepo);
    if (seg.scope === "close" && outer.length) ctx.cwdInRepo = outer.pop();
    if (seg.scope) continue;
    const target = seg.redirects.find((t) => isRepoPath(t, ctx));
    if (target !== undefined) return writeBlock("Die Umleitung `>`/`>>`", target);
    const verdict = checkWords(seg.words, ctx, dialect, seg.heredocs);
    if (verdict) return verdict;
  }
  return null;
}

/**
 * Checks one command. Returns null if it is allowed, otherwise { reason, alternative } (German).
 * @param {string} command
 * @param {string} toolName "Bash" or "PowerShell"
 * @param {string} [cwd] working directory from the hook event; without it the repository is assumed
 */
export function checkCommand(command, toolName, cwd) {
  const cwdInRepo = typeof cwd === "string" && cwd !== "" ? isRepoAbsolute(cwd) : true;
  try {
    return checkSource(String(command), toolName === "PowerShell" ? "ps" : "bash", { cwdInRepo });
  } catch (error) {
    if (error instanceof Unparseable) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------------------------------
// Hook entry point

function isMain() {
  if (!process.argv[1]) return false;
  const self = fileURLToPath(import.meta.url);
  const invoked = resolve(process.argv[1]);
  return process.platform === "win32" ? self.toLowerCase() === invoked.toLowerCase() : self === invoked;
}

if (isMain()) {
  let input = "";
  process.stdin.on("data", (c) => (input += c));
  process.stdin.on("end", () => {
    try {
      const event = JSON.parse(input);
      if (event?.tool_name !== "Bash" && event?.tool_name !== "PowerShell") return;
      const command = event?.tool_input?.command;
      if (typeof command !== "string") return;
      const verdict = checkCommand(command, event.tool_name, event.cwd);
      if (!verdict) return;
      process.stderr.write(
        `Blockiert von .claude/hooks/guard-commands.mjs: ${verdict.reason}\nStattdessen: ${verdict.alternative}\nRegeln: docs/agent-lessons-learned.md, Abschnitt 5.\n`,
      );
      process.exitCode = 2;
    } catch {
      // Invalid input or a bug in this hook: never block the work.
    }
  });
}

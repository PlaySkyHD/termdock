// Tests for the PreToolUse hook .claude/hooks/guard-commands.mjs. Run with `npm run test:hooks`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { URL, fileURLToPath } from "node:url";
import { checkCommand } from "../.claude/hooks/guard-commands.mjs";

const hook = fileURLToPath(new URL("../.claude/hooks/guard-commands.mjs", import.meta.url));

// [tool, command]
const blocked = [
  // git
  ["Bash", "git restore src/a.ts"],
  ["Bash", "git restore --staged ."],
  ["Bash", "git stash"],
  ["Bash", "git stash pop"],
  ["Bash", "git reset --hard origin/main"],
  ["Bash", "git -C P:/GitHub/termdock reset --hard"],
  ["Bash", "git -c core.pager=cat stash list"],
  ["Bash", "cd P:/GitHub/termdock-wt/feat/x && git restore ."],
  ["Bash", '"C:/Program Files/Git/cmd/git.exe" stash'],
  ["PowerShell", "git -C P:\\GitHub\\termdock stash"],
  ["PowerShell", "& git reset -q --hard HEAD"],
  // tmux
  ["Bash", "tmux -L termdock kill-server"],
  ["Bash", "tmux kill-server"],
  ["Bash", "tmux -Ltermdock kill-server"],
  ["Bash", "tmux -L termdock kill-session -t a \\; kill-server"],
  ["Bash", "wsl.exe -d Ubuntu -- tmux -L termdock kill-server"],
  ["Bash", "wsl.exe -d Ubuntu --cd ~ --exec tmux kill-server"],
  ["Bash", 'bash -lc "tmux -L termdock kill-server"'],
  ["PowerShell", "wsl.exe -d Ubuntu -- tmux -L termdock kill-server"],
  // wsl
  ["Bash", "wsl --shutdown"],
  ["Bash", "wsl.exe --terminate Ubuntu"],
  ["Bash", "wsl -t Ubuntu"],
  ["Bash", "C:/Windows/System32/wsl.exe --shutdown"],
  ["PowerShell", "wsl.exe --shutdown"],
  ["PowerShell", "WSL.EXE -t Ubuntu; wsl -l -v"],
  // sed, perl
  ["Bash", "sed -i 's/a/b/' packages/core/src/x.ts"],
  ["Bash", "sed -i.bak -e 's/a/b/' P:/GitHub/termdock-wt/feat/x/tasks.md"],
  ["Bash", "sed -Ei 's/a/b/' /p/GitHub/termdock/README.md"],
  ["Bash", "perl -pi -e 's/a/b/' src/x.ts"],
  // node
  ["Bash", "node -e \"require('fs').writeFileSync('src/a.ts', 'x')\""],
  ["Bash", "node --eval \"fs.appendFileSync('P:/GitHub/termdock/x.md','y')\""],
  ["Bash", "node -p \"require('fs').writeFileSync(process.argv[1], 'x')\" src/a.ts"],
  ["Bash", "node -e \"const fs=require('fs'); fs.writeSync(fs.openSync('a.ts','w'), 'x')\""],
  ["Bash", "node - <<'EOF'\nrequire('fs').writeFileSync('src/a.ts', 'x')\nEOF"],
  ["PowerShell", "node -e \"require('fs').writeFileSync('src\\a.ts', 'x')\""],
  // redirects and tee
  ["Bash", "echo x > src/a.ts"],
  ["Bash", "echo x >> P:/GitHub/termdock-wt/feat/y/tasks.md"],
  ["Bash", "printf 'x' >/p/GitHub/termdock/README.md"],
  ["Bash", "echo x 1> 'P:\\GitHub\\termdock\\a.md'"],
  ["Bash", "cd P:/Temp && echo x > P:/GitHub/termdock/a.md"],
  ["Bash", "cat >> docs/a.md <<'EOF'\nline > other\nEOF"],
  ["Bash", "cat <<EOF > src/x.ts\nexport const a = 1;\nEOF"],
  ["Bash", "echo x | tee src/a.ts"],
  ["Bash", "echo x | tee -a 'P:\\GitHub\\termdock\\a.md'"],
  ["PowerShell", "echo x > src\\a.ts"],
  // PowerShell cmdlets
  ["PowerShell", "Set-Content -Path P:\\GitHub\\termdock-wt\\x\\a.ts -Value 'x'"],
  ["PowerShell", "'x' | Out-File src\\a.ts"],
  ["PowerShell", 'Add-Content -LiteralPath "P:/GitHub/termdock/a.md" "x"'],
  ["PowerShell", "$c = Get-Content a.ts; $c | set-content a.ts -Encoding utf8"],
  ["PowerShell", "[IO.File]::WriteAllText('src\\a.ts', 'x')"],
];

const allowed = [
  // git
  ["Bash", "git status"],
  ["Bash", "git commit -F P:/Temp/td-issues/commit-43.txt"],
  ["Bash", 'git commit -m "fix: no git stash, git restore or wsl --shutdown here"'],
  ["Bash", 'git -c user.name=PlaySkyHD commit -m "a > b"'],
  ["Bash", "git reset --soft HEAD~1"],
  ["Bash", "git reset -- src/a.ts"],
  ["Bash", "git log --oneline > /dev/null"],
  ["Bash", "git commit -F - <<'EOF'\nfeat: a > b\n\ngit stash\nEOF"],
  ["Bash", "git -C P:/GitHub/termdock worktree remove --force P:/GitHub/termdock-wt/feat/x"],
  ["Bash", "rm -rf P:/GitHub/termdock-wt/feat/x"],
  ["PowerShell", "git commit -m @'\nfix: a > b\ngit stash\n'@"],
  // tmux and wsl
  ["Bash", "tmux -L termdock-test kill-server"],
  ["Bash", "tmux -L termdock-test-123-abc kill-server"],
  ["Bash", "tmux -L termdock kill-session -t foo"],
  ["Bash", "wsl.exe -d Ubuntu -- tmux -L termdock ls"],
  ["Bash", "wsl.exe -d Ubuntu --exec tmux -L termdock-test kill-server"],
  ["Bash", "wsl -l -v"],
  ["Bash", "wsl --update"],
  ["Bash", "wsl.exe -d Ubuntu --exec ls -t"],
  // redirects
  ["Bash", "npm test 2>&1 | tail -5"],
  ["Bash", "ls 2>/dev/null"],
  ["Bash", "echo x > P:/Temp/td-issues/a.txt"],
  ["Bash", "npm test -w packages/core 2> P:/Temp/err.txt >> /tmp/out.log"],
  ["Bash", "cat > P:/Temp/td-issues/body.md <<'EOF'\nsee > src/a.ts\nEOF"],
  ["Bash", "cd P:/Temp && echo x > out.txt"],
  ["Bash", 'echo "$HOME" > "$TMPDIR/x"'],
  ["PowerShell", "npm run lint > $null"],
  ["PowerShell", "npm run lint 2>&1 | Out-Null"],
  ["PowerShell", "npm test *> $null"],
  // reading commands with > in strings or comparisons
  ["Bash", 'grep "a > b" src/a.ts'],
  ["Bash", "[ $x -gt 1 ] && echo ok"],
  ["Bash", "awk '$1 > 0' file.txt"],
  ["Bash", "[[ $a > $b ]] && echo yes"],
  ["Bash", "(( x > 1 )) && echo yes"],
  ["Bash", "echo done # > src/a.ts"],
  ["PowerShell", "if ($x -gt 1) { 'ok' }"],
  // formatters, gh
  ["Bash", "npm run format"],
  ["Bash", "npx prettier --write packages/core/src/a.ts"],
  ["Bash", "gh pr create --title x --body-file P:/Temp/td-issues/pr.md"],
  ["Bash", "gh issue comment 43 --body-file P:/Temp/x.md"],
  // sed, perl, node, tee, cmdlets outside the repo or read-only
  ["Bash", "sed -n '1,5p' src/a.ts"],
  ["Bash", "sed -i 's/a/b/' P:/Temp/x.txt"],
  ["Bash", "perl -ne 'print if /x/' src/a.ts"],
  ["Bash", "node -e \"console.log(require('fs').readFileSync('package.json','utf8'))\""],
  ["Bash", "node -e \"require('fs').writeFileSync('P:/Temp/td/x.json','{}')\""],
  ["Bash", "node .claude/hooks/guard-commands.mjs < P:/Temp/x.json"],
  ["Bash", 'echo \'{"tool_name":"Bash"}\' | node x.mjs; echo $?'],
  ["Bash", "npm test 2>&1 | tee P:/Temp/log.txt"],
  ["PowerShell", "Set-Content -Path P:\\Temp\\x.txt -Value 'x'"],
  ["PowerShell", "'x' | Out-File -FilePath $env:TEMP\\a.txt"],
  ["PowerShell", "Get-Content src\\a.ts | Select-String foo"],
  ["PowerShell", "[IO.File]::WriteAllText('P:\\Temp\\a.txt', 'x')"],
];

for (const [tool, command] of blocked) {
  test(`blocks ${tool}: ${JSON.stringify(command)}`, () => {
    const verdict = checkCommand(command, tool);
    assert.ok(verdict, "expected a block");
    assert.match(verdict.reason, /\S/);
    assert.match(verdict.alternative, /\S/);
  });
}

for (const [tool, command] of allowed) {
  test(`allows ${tool}: ${JSON.stringify(command)}`, () => {
    assert.equal(checkCommand(command, tool), null);
  });
}

function runHook(stdin) {
  return spawnSync(process.execPath, [hook], { input: stdin, encoding: "utf8" });
}

test("hook exits 2 with a German reason on stderr for a blocked command", () => {
  const result = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command: "wsl --shutdown" } }));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Stattdessen/);
});

test("hook exits 0 for an allowed command", () => {
  const result = runHook(JSON.stringify({ tool_name: "PowerShell", tool_input: { command: "git status" } }));
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
});

test("hook exits 0 for other tools", () => {
  const result = runHook(JSON.stringify({ tool_name: "Read", tool_input: { command: "git stash" } }));
  assert.equal(result.status, 0);
});

test("hook exits 0 for invalid JSON or a missing command", () => {
  assert.equal(runHook("{not json").status, 0);
  assert.equal(runHook("").status, 0);
  assert.equal(runHook(JSON.stringify({ tool_name: "Bash" })).status, 0);
});

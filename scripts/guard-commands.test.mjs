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
  // PR #48 review: the fixes for false positives must keep these blocked
  ["Bash", "git reset --har HEAD"],
  ["Bash", 'wsl.exe -d Ubuntu -- "tmux -L termdock kill-server"'],
  ["Bash", 'powershell -Command "Set-Content src/a.ts x"'],
  ["Bash", "perl -Mstrict -pi -e 's/a/b/' src/x.ts"],
  ["Bash", "perl -l -pi -e 's/a/b/' src/x.ts"],
  ["PowerShell", "'x' | sc src\\a.ts"],
  ["Bash", "(cd P:/Temp && echo x > a.txt); echo y > b.txt"],
  ["Bash", "node gen.mjs > out.json", "P:/GitHub/termdock-wt/feat/x"],
  ["Bash", "cd P:/Temp && cd P:/GitHub/termdock && echo x > a.md", "P:/Temp"],
  // cp, mv, install (issue #111): the destination is a repository path
  ["Bash", "cp /p/Temp/bak/Sidebar.tsx P:/GitHub/termdock-wt/x/apps/desktop/src/renderer/Sidebar.tsx"],
  ["Bash", "cp P:/Temp/a.txt P:/GitHub/termdock/docs/a.md"],
  ["Bash", "cp -r P:/Temp/bak /p/GitHub/termdock-wt/feat/x/apps"],
  ["Bash", "mv P:/Temp/a.ts 'P:\\GitHub\\termdock\\src\\a.ts'"],
  ["Bash", "mv -f /tmp/a.ts /mnt/p/GitHub/termdock/src/a.ts"],
  ["Bash", "install -m 644 P:/Temp/a.ts P:/GitHub/termdock/src/a.ts"],
  ["Bash", "install -D P:/Temp/a.ts P:/GitHub/termdock/src/a.ts"],
  ["Bash", "cp P:/Temp/a.ts P:/Temp/b.ts P:/GitHub/termdock-wt/feat/x/"],
  ["Bash", "cp -t P:/GitHub/termdock/docs P:/Temp/a.md P:/Temp/b.md"],
  ["Bash", "cp -rt P:/GitHub/termdock/docs P:/Temp/a"],
  ["Bash", "cp --target-directory=P:/GitHub/termdock/docs P:/Temp/a.md"],
  ["Bash", "mv --target-directory P:/GitHub/termdock/docs P:/Temp/a.md"],
  ["Bash", "install -t P:/GitHub/termdock/bin P:/Temp/tool"],
  ["Bash", "cp -- P:/Temp/a.ts P:/GitHub/termdock/a.ts"],
  ["Bash", "sudo cp P:/Temp/a.ts P:/GitHub/termdock/a.ts"],
  // relative destination with cwd in the repository or a worktree
  ["Bash", "cp P:/Temp/a.ts src/a.ts"],
  ["Bash", "cp P:/Temp/a.ts src/a.ts", "P:/GitHub/termdock-wt/fix/issue-111-hook-cp-mv"],
  ["Bash", "mv -v P:/Temp/a.ts ./apps/a.ts", "P:\\GitHub\\termdock-wt\\feat\\x"],
  ["Bash", "cp -t src P:/Temp/a.ts", "P:/GitHub/termdock"],
  ["Bash", "cd P:/GitHub/termdock-wt/feat/x && cp P:/Temp/a.ts a.ts", "P:/Temp"],
  // chained commands are checked per segment
  ["Bash", "echo hi && cp P:/Temp/a.ts P:/GitHub/termdock/a.ts"],
  ["Bash", "ls; mv P:/Temp/a.ts P:/GitHub/termdock/a.ts"],
  ["Bash", "cat P:/Temp/list | cp P:/Temp/a.ts P:/GitHub/termdock/a.ts"],
  ["Bash", "cp P:/Temp/a.ts P:/Temp/b.ts && cp P:/Temp/a.ts a.ts", "P:/GitHub/termdock"],
  ["Bash", 'bash -c "cp P:/Temp/a.ts P:/GitHub/termdock/a.ts"'],
  ["Bash", "wsl.exe -d Ubuntu -- cp /tmp/a.ts /mnt/p/GitHub/termdock/a.ts"],
  ["Bash", "cp P:/Temp/a a.ts", "P:/GitHub/termdock-wt/single"],
  ["Bash", "cd P:/GitHub/termdock-wt/single && cp P:/Temp/a a.ts", "P:/Temp"],
  ["Bash", "cp --reflink a P:/GitHub/termdock/b"],
  ["Bash", "cp --sparse a P:/GitHub/termdock/b"],
  ["Bash", "cp P:/Temp/a P:/GitHub/termdock/../termdock-wt/x/b"],
  ["Bash", "cp a.ts ../b.ts", "P:/GitHub/termdock-wt/fix/x"],
  ["Bash", "cd .. && cp a b", "P:/GitHub/termdock-wt/fix/x/sub"],
  ["Bash", "cd P:/GitHub && cp a termdock/b", "P:/Temp"],
  ["PowerShell", "Copy-Item -Destination P:\\GitHub\\termdock\\a.ts -Path P:\\Temp\\a.ts"],
  ["Bash", "cp --target=P:/GitHub/termdock/docs P:/Temp/a.md"],
  ["Bash", "cp --target-dir P:/GitHub/termdock/docs P:/Temp/a.md"],
  ["Bash", "install -d -t P:/GitHub/termdock/bin P:/Temp/tool"],
  ["PowerShell", "copy P:\\Temp\\a.ts P:\\GitHub\\termdock\\a.ts"],
  ["PowerShell", "Copy-Item P:\\Temp\\a.ts -Dest P:\\GitHub\\termdock\\a.ts"],
  ["PowerShell", "cp P:\\Temp\\a.ts P:\\GitHub\\termdock\\a.ts"],
  ["PowerShell", "Copy-Item -Path P:\\Temp\\a.ts -Destination P:\\GitHub\\termdock\\a.ts"],
  ["PowerShell", "Move-Item P:\\Temp\\a.ts src\\a.ts", "P:\\GitHub\\termdock-wt\\feat\\x"],
  // git push from the main checkout (issue #128)
  ["Bash", "git push -u origin feat/x", "P:/GitHub/termdock"],
  ["PowerShell", "git push origin HEAD", "P:\\GitHub\\termdock"],
  ["Bash", "git -C P:/GitHub/termdock push"],
  ["Bash", "git -C ../termdock push", "P:/GitHub/termdock-wt"],
  ["Bash", "cd P:/GitHub/termdock && git push", "P:/Temp"],
  ["Bash", "git worktree remove x || true; git push origin feat/x", "P:/GitHub/termdock/apps"],
];

const allowed = [
  // git
  ["Bash", "git status"],
  ["Bash", "git push -u origin feat/x", "P:/GitHub/termdock-wt/feat/x"],
  ["Bash", "git -C P:/GitHub/termdock-wt/feat/x push -u origin feat/x", "P:/GitHub/termdock"],
  ["Bash", "cd P:/GitHub/termdock-wt/feat/x && git push", "P:/GitHub/termdock"],
  ["Bash", "git push"],
  ["Bash", "git -C P:/GitHub/termdock pull --ff-only origin main", "P:/GitHub/termdock"],
  ["Bash", 'git commit -m "no git push from the main checkout"', "P:/GitHub/termdock"],
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
  // PR #48 review: false positives
  ["Bash", "wsl -d Ubuntu -- awk '$1 > 5' /tmp/x"],
  ["Bash", "wsl.exe -d Ubuntu -- bash -c 'cd /tmp && echo x > y.txt'"],
  ["Bash", "powershell -Command Write-Output 'a > b'"],
  ["Bash", "perl -MFile::Spec -ne 'print' README.md"],
  ["Bash", "perl -Mwarnings -ne 'print' README.md"],
  ["Bash", "perl -I lib -ne 'print' README.md"],
  ["PowerShell", "sc.exe query wslservice"],
  ["Bash", "sc.exe query wslservice"],
  ["Bash", "sc query wslservice"],
  ["Bash", "node gen.mjs > out.json", "P:/Temp"],
  ["PowerShell", "node gen.mjs > out.json", "C:\\Users\\nicma\\AppData\\Local\\Temp"],
  ["Bash", "(cd P:/Temp && echo x > a.txt)"],
  ["Bash", 'git commit -m "$(cat <<\'EOF\'\nFix 1) parse "a > b" ok\nEOF\n)"'],
  ["Bash", 'git commit -m "$(cat <<\'EOF\'\nFix 1) parse \\"a > b\\" ok\nEOF\n)"'],
  ["Bash", 'echo "$(echo (unbalanced" > src/a.ts'],
  // cp, mv, install (issue #111): destination outside the repository
  ["Bash", "cp P:/GitHub/termdock/src/a.ts P:/Temp/a.ts"],
  ["Bash", "cp -r P:/GitHub/termdock-wt/feat/x/docs P:/Temp/docs-bak"],
  ["Bash", "mv P:/Temp/a.txt P:/Temp/b.txt"],
  ["Bash", "mv P:/Temp/a.txt b.txt", "P:/Temp"],
  ["Bash", "cp -r P:/Temp/a P:/Temp/b", "P:/GitHub/termdock"],
  ["Bash", "cp -r P:/Temp/a P:/Temp/b", "P:/GitHub/termdock-wt/fix/issue-111-hook-cp-mv"],
  ["Bash", "cp src/a.ts /tmp/a.ts", "P:/GitHub/termdock"],
  ["Bash", "cp src/a.ts ~/a.ts", "P:/GitHub/termdock"],
  ["Bash", 'cp src/a.ts "$TMPDIR/a.ts"', "P:/GitHub/termdock"],
  ["Bash", "cp -t P:/Temp/out src/a.ts src/b.ts", "P:/GitHub/termdock"],
  ["Bash", "cp --target-directory=P:/Temp/out src/a.ts", "P:/GitHub/termdock"],
  ["Bash", "mv src/a.ts /dev/null", "P:/GitHub/termdock"],
  ["Bash", "install -m 755 P:/Temp/tool /usr/local/bin/tool"],
  ["Bash", "install -d P:/GitHub/termdock/out"],
  ["Bash", "cp a.ts b.ts", "P:/Temp"],
  ["Bash", "cp a.ts ../../../Temp/b.ts", "P:/GitHub/termdock-wt/fix/x"],
  ["Bash", "cd .. && cp a b", "P:/GitHub/termdock-wt/fix"],
  ["Bash", "cd ../.. && cp a b", "P:/GitHub/termdock-wt/fix/x"],
  ["Bash", "cp P:/Temp/a P:/GitHub/termdock/../../Temp/b"],
  ["Bash", "echo x > ../../../Temp/o.txt", "P:/GitHub/termdock-wt/fix/x"],
  ["Bash", "cp P:/Temp/a P:/GitHub/termdockX/b"],
  ["Bash", "cp P:/Temp/a P:/GitHub/termdock-foo/b"],
  ["Bash", "echo x > P:/GitHub/termdock-foo/b"],
  ["Bash", "cp --reflink=auto a P:/Temp/b"],
  ["Bash", "cp --reflink a P:/Temp/b"],
  ["Bash", "git mv a.ts b.ts"],
  ["Bash", "git mv a.ts b.ts", "P:/GitHub/termdock-wt/fix/x"],
  ["PowerShell", "Copy-Item -Destination P:\\Temp\\a.ts -Path P:\\GitHub\\termdock\\a.ts"],
  ["Bash", "cd P:/Temp && cp a.ts b.ts", "P:/GitHub/termdock"],
  ["Bash", "cp --help"],
  ["Bash", "cp P:/Temp/a.ts"],
  ["Bash", "cp P:/Temp/a.ts P:/Temp/b.ts && echo P:/GitHub/termdock/x"],
  ["Bash", 'echo "cp P:/Temp/a.ts P:/GitHub/termdock/a.ts"'],
  ["Bash", 'git commit -m "docs: cp a.ts P:/GitHub/termdock/a.ts"'],
  ["Bash", "ls P:/GitHub/termdock | cp P:/Temp/a P:/Temp/b"],
  ["PowerShell", "Copy-Item -Path src\\a.ts -Destination P:\\Temp\\a.ts", "P:\\GitHub\\termdock"],
  ["PowerShell", "cp P:\\Temp\\a P:\\Temp\\b", "P:\\GitHub\\termdock"],
];

for (const [tool, command, cwd] of blocked) {
  test(`blocks ${tool}: ${JSON.stringify(command)}${cwd ? ` in ${cwd}` : ""}`, () => {
    const verdict = checkCommand(command, tool, cwd);
    assert.ok(verdict, "expected a block");
    assert.match(verdict.reason, /\S/);
    assert.match(verdict.alternative, /\S/);
  });
}

for (const [tool, command, cwd] of allowed) {
  test(`allows ${tool}: ${JSON.stringify(command)}${cwd ? ` in ${cwd}` : ""}`, () => {
    assert.equal(checkCommand(command, tool, cwd), null);
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

test("hook takes the working directory from the event", () => {
  const event = (cwd) =>
    JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command: "node g.mjs > o.json" } });
  assert.equal(runHook(event("P:\\Temp\\td")).status, 0);
  assert.equal(runHook(event("P:\\GitHub\\termdock-wt\\feat\\x")).status, 2);
});

test("hook blocks cp into the repository with the lessons message", () => {
  const command = "cp P:/Temp/bak/Sidebar.tsx P:/GitHub/termdock-wt/x/apps/desktop/Sidebar.tsx";
  const result = runHook(JSON.stringify({ tool_name: "Bash", tool_input: { command } }));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Repo-Dateien nur mit Read\/Edit\/Write ändern \(lessons Abschnitt 5\)/);
});

test("hook treats a relative cp destination by the event cwd", () => {
  const event = (cwd) =>
    JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command: "cp P:/Temp/a.ts a.ts" } });
  assert.equal(runHook(event("P:\\Temp\\td")).status, 0);
  assert.equal(runHook(event("P:\\GitHub\\termdock-wt\\feat\\x")).status, 2);
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

---
name: orchestrate-issues
description: Work several GitHub issues of this repo through subagents until their pull requests are merged. Use when the user asks to fix issues "per subagent", to work off agent-retro issues, to implement a concept phase, or to orchestrate parallel work.
---

# Orchestrate Issues

You plan, brief, verify, open the pull requests and merge. Subagents only implement, commit and push a branch.

## 1. Read the issues

- Read with `gh api repos/PlaySkyHD/termdock/issues/<n> --jq '.title, .body'` or `gh issue list --json number,title,body`.
- Read `docs/agent-lessons-learned.md`, `docs/adr/` and the concept (`docs/concept/v1-konzept.txt`) before planning.

## 2. Plan

- Map each issue to the packages and files it changes (`packages/<name>/`).
- Docs or skill changes of up to about ten lines in one file you make yourself. Longer docs go to a `haiku` subagent. OpenSpec changes go to a `sonnet` subagent or bigger.
- Disjoint packages: run in parallel. Same file, different places: parallel with exact anchors, check later with `git merge-tree`. Same lines or dependent work: sequential or stacked (branch B on branch A).
- Shared building blocks (protocol types, backend interface, a helper used by two packages) you build first on `main`, then brief the agents.
- Model: set `model` explicitly on every Agent call.
  - Default `sonnet`.
  - `haiku` for docs and skill texts.
  - `opus` for native PTY/ConPTY code (node-pty, Electron native modules), tmux reattach and resize logic, the Core lifecycle/reconcile and the input lock across windows.
  - At most two Opus agents at once, at most four agents in total.
- An issue with more than about three independent points goes to several agents.

## 3. Brief

Every prompt contains:

- the issue number and `gh api repos/PlaySkyHD/termdock/issues/<n> --jq '.title, .body'` to read it,
- "Read `docs/agent-lessons-learned.md` and the ADRs in `docs/adr/` first",
- the worktree setup (worktrees live on P:, not in the main checkout; see lessons section 1): `git -C P:/GitHub/termdock fetch origin`, then `git -C P:/GitHub/termdock worktree add P:/GitHub/termdock-wt/<branch> -b <branch> origin/main` (stacked: base on `origin/<parent-branch>`), then work only inside that worktree with absolute paths; if the fetch fails, stop and report,
- `npm ci` once in the fresh worktree,
- the graphify rule: if `graphify-out/graph.json` is missing run `graphify update .` in the worktree, then `graphify query "<question>"` before grep,
- no `git restore`, `git stash`, `git reset --hard`, `wsl --shutdown`/`--terminate` (the PreToolUse hook `.claude/hooks/guard-commands.mjs` blocks these and shell writes into the repository; the list is in lessons section 5); no pull request; no push to main; never touch the main checkout `P:/GitHub/termdock` except `fetch` and `worktree add`,
- file edits through Read, Edit and Write. A script that writes files is allowed only for a mechanical change across many lines (rename, conflict markers) and must be named with its exact command in the report under Umwege; never for logic changes. Formatters (`npm run format`) and generators may write. Commit messages via several `git commit -m`, not a heredoc,
- "the repository is public: no secrets, personal data or content about other private projects",
- the exact scope, the OpenSpec change name and capability, and which packages not to touch,
- the OpenSpec flow: create the change (`openspec-propose` skill), `bash scripts/openspec-check.sh <change>` (validates `--strict` plus what the CLI misses: Purpose of new capabilities, MODIFIED requirements over 500 characters), implement test-first (`tdd` skill), before archiving run the check again, archive in the same branch (`tools/openspec/node_modules/.bin/openspec archive <change> -y`), then `bash scripts/openspec-check.sh --specs`,
- the checks: `npm run typecheck`, `npm run lint`, `npm test -w <package>`; WSL integration tests with `TERMDOCK_WSL_TESTS=1` (see lessons section 2); never return unfiltered test output,
- for a bug fix: show the new test fails without the fix and put the red line in the report,
- for a visible UI change (`apps/desktop`, `poc/` UI): PNG screenshots of every changed state via the app's screenshot mode (`--screenshot <dir>`, `webContents.capturePage()`), before and after for changed behavior, saved outside the repo (`P:/Temp/td-shots/<branch>/`); list the paths in the report, do not commit them,
- before the push: commit, then run the skill `code-review` with the worktree path in the arguments (`low — local checkout: P:/GitHub/termdock-wt/<branch>, diff origin/main...HEAD`) and fix findings (amend) or state why not. The forked review runs in the session directory, which can be a different clone; a result without findings counts only if the review names files from the diff,
- the commit: Conventional Commits, body ends with `Fixes #<n>` and the Co-Authored-By line,
- `git push -u origin <branch>`,
- the report: branch, SHA, what changed, check output, and **Umwege** (anything done differently than expected, missing or wrong skills and rules, failed commands; "keine" if none).

Start agents in the background. Do not touch their worktrees while they run.

## 4. Verify each result

"Done" is not verified. For every branch:

- `git diff origin/main origin/<branch> --stat` matches the scope; read the diff.
- If the report names a writing script, read the full diff of every file it touched.
- Run `npm run typecheck`, `npm run lint` and the package tests yourself in the agent's worktree.
- `git merge-tree --write-tree origin/<a> origin/<b>` for every pair of branches touching the same file.
- Fix small gaps yourself; send larger ones back via `SendMessage` to the same agent.

## 5. Pull requests and merge

- One PR per issue with `gh pr create`, `Fixes #<n>` in the body. Register it with T3 if `link_pull_request` exists.
- UI change: look at the screenshots yourself, then attach them right after `gh pr create`: `bash scripts/attach-screenshots.sh pr <n> --title "Vorher / Nachher" <files…>`. An issue about visible behavior gets screenshots the same way (`issue <n>`). No screenshots for a UI change → send the agent back before the PR.
- Review right after `gh pr create`: `code-review <PR>` (`medium --max-findings 5`; after a rework `low`; Core lifecycle, input lock or reconcile: `high`). Use the `termdock-review` skill for what to check. Always add `Local checkout of the PR branch: P:/GitHub/termdock-wt/<branch> (diff origin/main...HEAD)` to the arguments; without it the forked review may read a different clone (PR #39).
- Read the review's coverage note, not only the findings. If it says the diff was cut off or files were skipped, rerun `code-review` with path targets for the missing files (PR #8: `registry.ts` skipped at 60 KB; PR #10: end of `server.ts` skipped). For PRs over about 1500 changed lines, review with path targets per package from the start.
- Triage: only correctness bugs inside the issue's scope go back to the agent. Extensions and style become new issues or are rejected with a reason.
- Watch checks with `bash scripts/pr-wait.sh --timeout 60 <prs…>` via Bash `run_in_background`.
- Merge only when checks are green and review findings are fixed or rejected.
- On `merge conflict with base`: `git -C P:/GitHub/termdock fetch origin`, then `git merge origin/main` in the worktree, resolve, rerun the checks, push and wait again (PR #50). Parallel PRs append requirements to the end of the same spec (`openspec/specs/<cap>/spec.md`); that conflict is expected: keep both blocks, then run `bash scripts/openspec-check.sh --specs`.
- Only after a fresh `pr-wait.sh` run reports `checks passed (mergeable_state: clean)` for this PR (after every merge, run it again for the remaining PRs), remove the worktree, each step on its own (no `&&` chain): `git -C P:/GitHub/termdock worktree remove --force P:/GitHub/termdock-wt/<branch> || true`, `rm -rf P:/GitHub/termdock-wt/<branch>`, `git -C P:/GitHub/termdock worktree prune`. Then `gh pr merge <n> --merge --delete-branch` and `git -C P:/GitHub/termdock pull --ff-only`. With the worktree still present, `--delete-branch` fails and leaves the remote branch (PR #30); `worktree remove` usually reports "Directory not empty" because of `node_modules` leftovers.
- After each merge, check the remaining PRs; on a conflict, merge `origin/main` into the branch and push.

## 6. Retro once at the end

Run the `retro` skill once after the last PR of a round. Feed it the agents' Umwege plus your own observations.

## 7. Report

Tell the user per issue: PR, merge commit, what changed, and any Umwege that became new issues.

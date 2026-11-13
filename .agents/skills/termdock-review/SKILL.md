---
name: termdock-review
description: Review rules of the TermDock repo. Use when reviewing a diff, branch or pull request in this repository, before writing review findings.
---

# TermDock Review

1. Read `.agents/instructions/code-review.instructions.md`. It defines what counts as a finding, the severity model, the output and the OpenSpec checks.
2. Read `typescript.instructions.md` for `packages/` and `apps/`, and always `security.instructions.md`.
3. Apply `docs/agent-lessons-learned.md` and the ADRs in `docs/adr/` as repo-specific review knowledge.
4. Read a pull request or branch without changing the working tree: `gh pr diff <n>`, `git diff origin/main...origin/<branch>` and `git show origin/<branch>:<path>`. Never run `git checkout`, `git switch` or `git worktree` in the caller's directory.

When another review skill or command sets the output format (for example a findings tool), keep that format and use these files for what to check and how to rate severity.

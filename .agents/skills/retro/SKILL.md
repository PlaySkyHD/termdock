---
name: retro
description: Retrospective on the current coding session that files improvements to the agent environment as GitHub issues. Use right after creating a pull request (a hook reminds you), or when the user asks for a retro.
---

# Retro

You improve the **environment** for future agent runs: skills, rules, lessons, checks, tooling. You do not review the product code; `termdock-review` does that.

## Steps

1. **Collect evidence from this session.** Default to the current session, which is in your context. For another session, read its transcript under `~/.claude/projects/<repo-slug>/<session-id>.jsonl`. For questions about usage, quota or context size, run `py -I scripts/agent-usage.py ~/.claude/projects/<slug>/<session-id>` (path without `.jsonl`; `<slug>` is the session's working directory with `/` replaced by `-`, for T3 worktrees the worktree path, see `ls ~/.claude/projects`; per agent: model, turns, context, cache rebuilds, share of the total) instead of reading transcripts. Run it in every retro, not only on request: report the three largest cost drivers (transcript, model, average context, rework rounds) and treat any driver above about 15 % as a candidate. Also run `py -I scripts/adhoc-code.py` with the same path in every retro: it lists inline code (`py -c`, `node -e`), long heredocs, script files written outside the repo and repeated long shell commands, each with its size in characters. The script only knows these patterns: when it finds nothing, fails, or misses code you remember writing, search the session log yourself instead of skipping the check. Print short snippets, never whole JSON lines: `grep -o -E '.{0,60}((py|python3?|node)( -[A-Za-z]+)* -[cep] |<<-? ?.?EOF|"file_path":"[^"]*\.(py|c?js|mjs|sh|ps1)").{0,40}' <session>.jsonl | sort -u | head -40`. Note each moment where the agent:
   - was corrected by the user or had to redo work,
   - searched long for a file, command, skill or fact,
   - followed a skill, rule or lesson that was wrong, outdated or contradicted the code,
   - needed a skill or rule that did not exist, or worked around a missing one,
   - made a mistake that a test, analyzer, formatter or CI job could have caught,
   - made an expensive or repeated tool call that a better tool or pointer would avoid,
   - wrote or ran throwaway code (Python, Node, shell scripts, heredocs) for a task that will come back,
   - lacked information (logs, server state, credentials flow) and had to guess or ask.
2. **Classify each candidate** with the categories below and pick the cheapest durable fix.
3. **Drop weak candidates.** Keep only findings with a concrete moment from the session as evidence. Keep at most three, ordered by how much time or risk they cost. Before filing, confirm the suspected cause with a quick test: rerun the command, call the hook with sample JSON, or read the code location. If you cannot confirm it, drop the finding or mark it clearly as a hypothesis in the issue.
4. **Check the proposed text.** Write the Vorschlag so it can be applied as written; the orchestrator checks it again before use (`orchestrate-issues`, section 2), but do not rely on that.
   - Check every number, threshold, path, command and API name in it against the code (`graphify update .` if `graphify-out/graph.json` is missing, `graphify query`, then grep). Grep every type and member name and write members as `Type.Member` exactly as in the code .
   - Read the section the Vorschlag goes into. The new text must not contradict a neighbouring rule; if it overrides one, change that rule in the same Vorschlag.
   - Put a rule in one file and point to it from others (see Steering hygiene). If it must stand in two files, both get the same wording and scope.
   - A value that holds for one widget, endpoint or job only is written with that scope.
5. **File them** as described under "Issues". If nothing survives, say so in one line and stop.
6. **Report** in two or three lines which issues you created or commented on.

## Categories

- **Skills and rules**: a skill or instruction in `.agents/` is missing, wrong, too vague, or contradicts the repo. Fix the source file in `.agents/`; `.claude/` only links to it.
- **Automated checks**: a mechanical mistake (fixed pattern, banned API, file location, format) gets a deterministic check: analyzer rule, test, architecture test or CI step. Read the existing checks first (`.github/workflows/`, `eslint.config.js`, `package.json` scripts); an existing but unwired check is the finding. Prefer a check over a written rule.
- **Review rules**: a judgement call the reviewer should enforce goes into `.agents/instructions/code-review.instructions.md`, not into implementation rules. The reviewer has the least context pressure.
- **Navigation**: the agent took long to find something. Add a pointer in the file the agent reads first (lessons, a rule, a skill), not a new document.
- **Lessons**: a pitfall that cost time and will recur goes into `docs/agent-lessons-learned.md` in the matching section.
- **Steering hygiene**: `CLAUDE.md` and always-loaded rules stay short and hold pointers. Flag instructions that changed nothing, duplicate another file, or belong in a skill loaded on demand.
- **Tool economy**: a call that returned far more than needed, or a sequence that one command or script could replace.
- **Script candidates**: throwaway code from `scripts/adhoc-code.py` that solves a recurring task becomes a script under `scripts/` with a test (`scripts/*_test.py` or `*.test.mjs`), or a skill when it needs judgement. Point to it from the skill or lesson that is read at that moment. One-off probes stay throwaway. Code that edits repo files is no script candidate: the finding is a breach of "edit files with Read/Edit/Write" (lessons section 5).
- **Information access**: a missing log, status or read-only view that would have answered the question directly.

## Issues

- Search first: `gh issue list --label agent-retro --state open --search "<keywords>"`. If an open issue covers the same cause, add a comment with the new evidence instead of a new issue.
- Create: `gh issue create --label agent-retro --title "<Bereich>: <Problem>" --body-file <file>`. Write title and body in German.
- Body, short:
  - **Beobachtung**: what happened in the session, with the PR number.
  - **Ursache**: the file or missing piece that caused it.
  - **Vorschlag**: the concrete change and the file it goes in, checked as in step 4. Name the merged commit or the code location the values come from.
  - **Kategorie**: one of the categories above.
- The repository is public. Never include secrets, tokens, personal data, user prompts verbatim, or anything about other private projects.
- Do not fix findings inside the pull request you just opened. Each fix is its own pull request that closes the issue with `Fixes #<n>`.

## Writing for agents

Write fixes the way agents read them: short declarative sentences, one rule per line, the reason in a few words, a concrete command or path instead of a description. Put a rule where it is read at the right moment: always-loaded files only for pointers, skills for knowledge needed on demand, review rules for judgement calls, checks for everything mechanical.

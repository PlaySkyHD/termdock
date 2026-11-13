#!/usr/bin/env bash
# Waits quietly until every given PR reached a final state, then exits.
# Usage: scripts/pr-wait.sh [--timeout <minutes>] [--interval <seconds>] <pr> [<pr> ...]
# Prints one line per PR only when it is final: checks passed, checks failed
# (with names), merged, closed, conflicting or unreadable. Comments (Sonar, bots)
# are ignored. Exit code: 0 all fine, 1 any PR needs attention, 2 timeout/usage.
# Meant for Bash run_in_background, so the orchestrator wakes up once at the end.
set -euo pipefail

repo="PlaySkyHD/termdock"
timeout_min=120
interval=60
prs=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout) timeout_min="${2:-x}"; shift 2 || shift ;;
    --interval) interval="${2:-x}"; shift 2 || shift ;;
    ''|*[!0-9]*) echo "usage: $0 [--timeout <min>] [--interval <s>] <pr> [<pr> ...]" >&2; exit 2 ;;
    *) prs+=("$1"); shift ;;
  esac
done
usage="usage: $0 [--timeout <min>] [--interval <s, >=1>] <pr> [<pr> ...]"
[[ "$timeout_min" =~ ^[0-9]+$ && "$interval" =~ ^[0-9]+$ && "$interval" -ge 1 && ${#prs[@]} -gt 0 ]] \
  || { echo "$usage" >&2; exit 2; }

declare -A done_pr=() errors=() dirty_sha=()
attention=0
deadline=$((SECONDS + timeout_min * 60))

# Prints a final line for the PR, or nothing while it is still pending.
check_pr() {
  local n="$1" pr state merged mstate sha suites runs failed
  if ! pr=$(gh api "repos/$repo/pulls/$n" --jq '[.state, .merged, (.mergeable_state // "unknown"), .head.sha] | join("|")' 2>/dev/null); then
    errors[$n]=$(( ${errors[$n]:-0} + 1 ))
    if [[ "${errors[$n]}" -ge 3 ]]; then
      echo "#$n: not readable (not found or gh error)" >&2; attention=1; done_pr[$n]=1
    fi
    return
  fi
  errors[$n]=0
  IFS='|' read -r state merged mstate sha <<<"$pr"
  if [[ "$merged" = "true" ]]; then echo "#$n: merged"; done_pr[$n]=1; return; fi
  if [[ "$state" != "open" ]]; then echo "#$n: closed without merge"; attention=1; done_pr[$n]=1; return; fi
  # Right after a push GitHub can still report the old "dirty" (PR #11); only a repeat for the same head counts.
  if [[ "$mstate" = "dirty" ]]; then
    if [[ "${dirty_sha[$n]:-}" = "$sha" ]]; then
      echo "#$n: merge conflict with base"; attention=1; done_pr[$n]=1; return
    fi
    dirty_sha[$n]="$sha"; return
  fi
  dirty_sha[$n]=""
  # Suites exist before their runs do (late workflows, jobs behind needs:).
  suites=$(gh api "repos/$repo/commits/$sha/check-suites?per_page=100" \
    --jq '[.check_suites[] | select(.latest_check_runs_count > 0 or .app.slug == "github-actions") | select(.status != "completed")] | length' 2>/dev/null) || return 0
  [[ "$suites" = "0" ]] || return 0
  runs=$(gh api "repos/$repo/commits/$sha/check-runs?per_page=100" \
    --jq '[.check_runs[] | .status + "/" + (.conclusion // "-") + "/" + .name] | .[]' 2>/dev/null) || return 0
  [[ -n "$runs" ]] || return 0                       # checks not registered yet
  if grep -qvE '^completed/' <<<"$runs"; then return 0; fi   # still running
  failed=$(grep -E '^completed/(failure|timed_out|cancelled|action_required|startup_failure|stale)/' <<<"$runs" \
    | cut -d/ -f3- | paste -sd, - || true)
  if [[ -n "$failed" ]]; then
    echo "#$n: checks failed: $failed"; attention=1
  elif [[ "$mstate" = "unknown" ]]; then
    return 0                                       # GitHub still computes mergeability
  else
    echo "#$n: checks passed (mergeable_state: $mstate)"
  fi
  done_pr[$n]=1
}

while :; do
  open=0
  for n in "${prs[@]}"; do
    [[ -n "${done_pr[$n]:-}" ]] && continue
    check_pr "$n"
    [[ -n "${done_pr[$n]:-}" ]] || open=1
  done
  [[ "$open" -eq 0 ]] && exit "$attention"
  if [[ "$SECONDS" -ge "$deadline" ]]; then
    pending=""
    for n in "${prs[@]}"; do [[ -n "${done_pr[$n]:-}" ]] || pending+="#$n "; done
    echo "timeout after ${timeout_min} min, still pending: ${pending% }"
    exit 2
  fi
  sleep "$interval"
done

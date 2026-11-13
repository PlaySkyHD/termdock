#!/usr/bin/env bash
# Uploads screenshots to the orphan branch `pr-assets` and posts them as a comment on a PR or issue.
# Usage: scripts/attach-screenshots.sh pr|issue <number> [--title "<text>"] <file.png> [<file.png> ...]
# Files land in pr-assets:<kind>-<number>/<basename>; the comment embeds them via raw.githubusercontent.com
# (the repository is public). Name files after what they show, e.g. sidebar-before.png, sidebar-after.png.
set -euo pipefail

repo="PlaySkyHD/termdock"
branch="pr-assets"
usage="usage: $0 pr|issue <number> [--title <text>] <file.png> [<file.png> ...]"

kind="${1:-}"; number="${2:-}"
[[ "$kind" == "pr" || "$kind" == "issue" ]] && [[ "$number" =~ ^[0-9]+$ ]] || { echo "$usage" >&2; exit 2; }
shift 2
title="Screenshots"
if [[ "${1:-}" == "--title" ]]; then title="${2:?$usage}"; shift 2; fi
[[ $# -gt 0 ]] || { echo "$usage" >&2; exit 2; }
for f in "$@"; do
  [[ -f "$f" ]] || { echo "not a file: $f" >&2; exit 2; }
  [[ "$(basename "$f")" =~ ^[A-Za-z0-9._-]+$ ]] || { echo "use only A-Z a-z 0-9 . _ - in file names: $f" >&2; exit 2; }
done

root="$(git rev-parse --show-toplevel)"
work="$(mktemp -d)"
trap 'git -C "$root" worktree remove --force "$work" >/dev/null 2>&1 || true; rm -rf "$work"' EXIT

git -C "$root" fetch -q origin
if git -C "$root" ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  git -C "$root" worktree add -q --detach "$work" "origin/$branch"
else
  git -C "$root" worktree add -q --detach "$work"
  git -C "$work" checkout -q --orphan "$branch"
  git -C "$work" rm -rfq . >/dev/null 2>&1 || true
  printf '# pr-assets\n\nScreenshots for pull requests and issues. Written by scripts/attach-screenshots.sh.\n' >"$work/README.md"
  git -C "$work" add README.md
fi

dir="$kind-$number"
mkdir -p "$work/$dir"
body="### $title"$'\n'
for f in "$@"; do
  name="$(basename "$f")"
  cp "$f" "$work/$dir/$name"
  git -C "$work" add "$dir/$name"
  body+=$'\n'"**${name%.*}**"$'\n\n'"![${name%.*}](https://raw.githubusercontent.com/$repo/$branch/$dir/$name)"$'\n'
done

# Re-uploading identical files stages nothing; the comment is still posted.
if ! git -C "$work" diff --cached --quiet; then
  git -C "$work" -c user.name=PlaySkyHD commit -qm "assets: screenshots for $kind #$number"
  git -C "$work" push -q origin "HEAD:refs/heads/$branch"
fi

if [[ "$kind" == "pr" ]]; then
  gh pr comment "$number" --repo "$repo" --body "$body"
else
  gh issue comment "$number" --repo "$repo" --body "$body"
fi

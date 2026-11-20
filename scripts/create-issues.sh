#!/usr/bin/env bash
# Creates several GitHub issues that refer to each other, in the order of a plan, and replaces the placeholders
# `{{<key>}}` in the texts with the numbers of the new issues. Replaces with the bare number: write `#{{key}}`.
#
# Usage: scripts/create-issues.sh [--dry-run] <folder>
#   <folder>/plan.txt    one issue per line: `<key>|<labels>|<title>` (labels separated by commas, may be empty;
#                        empty lines and lines starting with `#` are ignored; a `|` in the title is fine)
#   <folder>/<key>.md    the text of the issue; write it with the Write tool, not with a heredoc
#   <folder>/numbers.txt written by the run: `<key>|<number>` per created issue
#
# Keys are letters, digits, `_` and `-`. Placeholders work in texts, not in titles. A reference to an issue that is
# created later (or to the issue itself) is left open in the first pass and filled in by a second pass with
# `gh issue edit`. Before anything is created the script checks the whole plan and stops on a missing text, a double
# key or a placeholder without a key in the plan, so a typo creates no issues. After the run no `{{` is left.
# A folder with a `numbers.txt` is refused (the run was done already or broke off; see the file for what exists).
#
# --dry-run only checks and prints what would happen; it calls neither `gh` nor writes `numbers.txt`.
# Environment: GH (default `gh`), GH_REPO as for gh itself.
set -euo pipefail
export LC_ALL=C.UTF-8

dry=0
if [[ "${1:-}" == "--dry-run" ]]; then
  dry=1
  shift
fi
folder="${1:-}"
[[ $# -eq 1 && -n "$folder" ]] || { echo "usage: $0 [--dry-run] <folder>" >&2; exit 2; }
folder="${folder%/}"
plan="$folder/plan.txt"
[[ -f "$plan" ]] || { echo "missing $plan" >&2; exit 2; }
gh_bin="${GH:-gh}"

keys=()
declare -A label_of title_of
line_no=0
while IFS= read -r line || [[ -n "$line" ]]; do
  line_no=$((line_no + 1))
  line="${line%$'\r'}"
  [[ -z "${line//[[:space:]]/}" || "$line" == \#* ]] && continue
  IFS='|' read -r key labels title <<<"$line"
  [[ "$line" == *"|"*"|"* ]] || { echo "plan.txt line $line_no: expected <key>|<labels>|<title>" >&2; exit 2; }
  [[ "$key" =~ ^[A-Za-z0-9_-]+$ ]] || { echo "plan.txt line $line_no: bad key '$key' (letters, digits, _ and - only)" >&2; exit 2; }
  [[ -n "${title//[[:space:]]/}" ]] || { echo "plan.txt line $line_no: empty title for '$key'" >&2; exit 2; }
  [[ "$title" != *"{{"* ]] || { echo "plan.txt line $line_no: no placeholders in titles ('$key')" >&2; exit 2; }
  [[ -z "${label_of[$key]+x}" ]] || { echo "plan.txt line $line_no: key '$key' is used twice" >&2; exit 2; }
  [[ -f "$folder/$key.md" ]] || { echo "missing text $folder/$key.md" >&2; exit 2; }
  keys+=("$key")
  label_of[$key]="$labels"
  title_of[$key]="$title"
done <"$plan"
[[ ${#keys[@]} -gt 0 ]] || { echo "plan.txt has no issues" >&2; exit 2; }

# Placeholders per key (space separated, in order of appearance) and the check that each one names a key of the plan.
declare -A refs_of
unknown=0
for key in "${keys[@]}"; do
  refs=""
  while IFS= read -r placeholder; do
    [[ -n "$placeholder" ]] || continue
    name="${placeholder#\{\{}"
    name="${name%\}\}}"
    if [[ -z "${label_of[$name]+x}" ]]; then
      echo "open placeholder $placeholder in $folder/$key.md: no such key in plan.txt" >&2
      unknown=1
    else
      case " $refs " in *" $name "*) ;; *) refs="$refs $name" ;; esac
    fi
  done < <(grep -o '{{[^}]*}}' "$folder/$key.md" || true)
  refs_of[$key]="${refs# }"
done
# A `{{` that does not form a complete placeholder is a typo as well.
for key in "${keys[@]}"; do
  stripped="$(sed 's/{{[^}]*}}//g' "$folder/$key.md")"
  if [[ "$stripped" == *"{{"* || "$stripped" == *"}}"* ]]; then
    echo "broken placeholder in $folder/$key.md (unbalanced {{ or }})" >&2
    unknown=1
  fi
done
[[ $unknown -eq 0 ]] || exit 1

# Placeholders that point to an issue created at the same time or later.
declare -A forward_of
for i in "${!keys[@]}"; do
  key="${keys[$i]}"
  forward=""
  for name in ${refs_of[$key]}; do
    for j in "${!keys[@]}"; do
      if [[ "${keys[$j]}" == "$name" && $j -ge $i ]]; then forward="$forward $name"; fi
    done
  done
  forward_of[$key]="${forward# }"
done

if [[ $dry -eq 1 ]]; then
  echo "dry run: ${#keys[@]} issues, nothing is created"
  for key in "${keys[@]}"; do
    echo "- $key [${label_of[$key]}] ${title_of[$key]}"
    echo "    refers to: ${refs_of[$key]:-(none)}"
    [[ -z "${forward_of[$key]}" ]] || echo "    forward references (second pass): ${forward_of[$key]}"
  done
  exit 0
fi

numbers="$folder/numbers.txt"
[[ ! -e "$numbers" ]] || { echo "$numbers exists: the run was done or broke off, check the issues listed there" >&2; exit 2; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
declare -A number_of
# numbers.txt appears with the first created issue, so a run that fails at issue 1 can simply be repeated.

# The text of `key` with every placeholder replaced whose issue exists; the others stay open.
render() {
  local key="$1" text name
  text="$(cat "$folder/$key.md"; printf x)"
  text="${text%x}"
  for name in ${refs_of[$key]}; do
    if [[ -n "${number_of[$name]+x}" ]]; then text="${text//"{{$name}}"/${number_of[$name]}}"; fi
  done
  printf '%s' "$text"
}

for key in "${keys[@]}"; do
  render "$key" >"$tmp/body.md"
  args=(issue create --title "${title_of[$key]}" --body-file "$tmp/body.md")
  if [[ -n "${label_of[$key]}" ]]; then
    IFS=',' read -r -a label_list <<<"${label_of[$key]}"
    for label in "${label_list[@]}"; do args+=(--label "$label"); done
  fi
  url="$("$gh_bin" "${args[@]}")"
  num="${url##*/}"
  [[ "$num" =~ ^[0-9]+$ ]] || { echo "no issue number in the answer of gh for '$key': $url" >&2; exit 1; }
  number_of[$key]="$num"
  echo "$key|$num" >>"$numbers"
  echo "created #$num $key"
done

for key in "${keys[@]}"; do
  [[ -n "${forward_of[$key]}" ]] || continue
  render "$key" >"$tmp/body.md"
  if grep -q '{{' "$tmp/body.md"; then echo "open placeholder left in $key" >&2; exit 1; fi
  "$gh_bin" issue edit "${number_of[$key]}" --body-file "$tmp/body.md" >/dev/null
  echo "updated #${number_of[$key]} $key (references to: ${forward_of[$key]})"
done
echo "done: $numbers"

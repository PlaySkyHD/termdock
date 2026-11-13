#!/usr/bin/env bash
# Catches what `openspec validate <change> --strict` lets through but `openspec validate --specs --strict`
# rejects after `openspec archive`: a missing or TBD Purpose of a new capability and requirements over 500
# characters. Run it before archiving.
# Usage: scripts/openspec-check.sh <change>     (an open change under openspec/changes/)
#        scripts/openspec-check.sh --specs      (the main specs under openspec/specs/)
set -euo pipefail
export LC_ALL=C.UTF-8

root="$(git rev-parse --show-toplevel)"
cli="$root/tools/openspec/node_modules/.bin/openspec"
[[ -x "$cli" ]] || { echo "OpenSpec CLI missing: npm ci --prefix tools/openspec --ignore-scripts" >&2; exit 2; }
max=500
failed=0

# Prints "<line>: <length>" for every requirement whose text (between the heading and the first scenario) is too long.
long_requirements() {
  awk -v max="$max" '
    function flush() { if (name != "" && length(text) > max) printf "%d: %s (%d Zeichen)\n", start, name, length(text) }
    /^### Requirement:/ { flush(); name = substr($0, 18); start = NR; text = ""; inreq = 1; next }
    /^#### Scenario:/ || /^## / { flush(); name = ""; inreq = 0; next }
    inreq { line = $0; gsub(/^[ \t]+|[ \t]+$/, "", line); if (line != "") text = text (text == "" ? "" : " ") line }
    END { flush() }
  ' "$1"
}

# True when the file has a "## Purpose" section with real text.
has_purpose() {
  awk '
    /^## Purpose/ { inp = 1; next }
    /^## / { inp = 0 }
    inp { line = $0; gsub(/[ \t]/, "", line); if (line != "" && line !~ /^TBD/) found = 1 }
    END { exit found ? 0 : 1 }
  ' "$1"
}

check_lengths() {
  local file="$1" out
  out="$(long_requirements "$file")"
  if [[ -n "$out" ]]; then
    while IFS= read -r line; do echo "::error file=$file::Anforderung über $max Zeichen, Zeile $line"; done <<<"$out"
    failed=1
  fi
}

if [[ "${1:-}" == "--specs" ]]; then
  "$cli" validate --specs --strict || failed=1
  for file in "$root"/openspec/specs/*/spec.md; do
    [[ -f "$file" ]] || continue
    check_lengths "$file"
    has_purpose "$file" || { echo "::error file=$file::Purpose fehlt oder ist TBD"; failed=1; }
  done
  exit "$failed"
fi

change="${1:?usage: $0 <change> | --specs}"
dir="$root/openspec/changes/$change"
[[ -d "$dir" ]] || { echo "no open change: openspec/changes/$change" >&2; exit 2; }
# The CLI checks ADDED requirements itself but not the full length of MODIFIED ones; keep going to report both.
"$cli" validate "$change" --strict || failed=1

for file in "$dir"/specs/*/spec.md; do
  [[ -f "$file" ]] || continue
  capability="$(basename "$(dirname "$file")")"
  check_lengths "$file"
  # A new capability gets its main spec from this delta; without a Purpose archive writes "TBD".
  if [[ ! -f "$root/openspec/specs/$capability/spec.md" ]] && ! has_purpose "$file"; then
    echo "::error file=$file::Neue Capability '$capability' braucht einen '## Purpose' mit Text im Delta (sonst TBD nach archive)"
    failed=1
  fi
done
exit "$failed"

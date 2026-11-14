"""Findet Ad-hoc-Code in einer Claude-Code-Session und ihren Subagents (nur lesend).

Aufruf (Pfad ohne .jsonl, wie bei scripts/agent-usage.py):

    py -I scripts/adhoc-code.py ~/.claude/projects/<slug-des-arbeitsverzeichnisses>/<session-id>

Gefunden werden Kandidaten für ein Skript unter scripts/ oder einen Skill:

- inline:  Shell-Befehle, die Code direkt ausführen (`py -c`, `python -`, `node -e`, `node -p`).
- heredoc: Heredocs mit mindestens HEREDOC_MIN_LINES Zeilen (Skripte, Dateiinhalte, Issue-Texte).
- script:  mit dem Write-Tool geschriebene Skriptdateien außerhalb des Repos und seiner Worktrees
           (`<repo>/`, `<repo>-wt/`); Dateien im Repo sind Produktcode oder schon ein Skript.
- repeat:  lange Shell-Befehle (ab REPEAT_MIN_CHARS), die mit anderen Werten mindestens
           REPEAT_MIN_COUNT-mal vorkommen.

Zeichen sind eine grobe Näherung für Output-Tokens (etwa vier Zeichen je Token).
"""
import collections
import glob
import json
import os
import re
import sys

JSONL_SUFFIX = ".jsonl"
SHELL_TOOLS = ("Bash", "PowerShell")
SCRIPT_SUFFIXES = (".py", ".js", ".cjs", ".mjs", ".ts", ".sh", ".ps1")
HEREDOC_MIN_LINES = 5
REPEAT_MIN_CHARS = 200
REPEAT_MIN_COUNT = 3
MAX_ROWS = 30

INLINE = re.compile(r"\b(?:py|python3?|node|electron)(?:\.exe)?(?:\s+-[A-Za-z]+)*\s+(?:-c|-e|-p|--eval|-)(?=\s|$)")
HEREDOC = re.compile(r"<<-?\s*['\"]?(\w+)['\"]?")
QUOTED = re.compile(r"'[^']*'|\"(?:[^\"\\]|\\.)*\"")
NUMBER = re.compile(r"\d+")
SPACES = re.compile(r"\s+")


def first_line(text, width=90):
    line = next((part.strip() for part in text.splitlines() if part.strip()), "")
    return line if len(line) <= width else line[: width - 3] + "..."


def heredoc_lines(command):
    """Längster Heredoc im Befehl in Zeilen (0 ohne Heredoc)."""
    longest = 0
    for match in HEREDOC.finditer(command):
        lines = command[match.end():].splitlines()[1:]
        body = 0
        for line in lines:
            if line.strip() == match.group(1):
                break
            body += 1
        longest = max(longest, body)
    return longest


def shape(command):
    """Form eines Befehls ohne Werte: Strings und Zahlen ersetzt, Leerraum vereinheitlicht."""
    return SPACES.sub(" ", NUMBER.sub("N", QUOTED.sub("Q", command))).strip()


def repo_roots(cwd):
    """Pfadteile, an denen Dateien im Repo oder einem seiner Worktrees erkannt werden."""
    if not cwd:
        return ()
    name = os.path.basename(cwd.replace("\\", "/").rstrip("/")).lower()
    return (f"/{name}/", f"/{name}-wt/")


def outside_repo(path, roots):
    normalized = "/" + path.replace("\\", "/").lower().lstrip("/")
    return not any(root in normalized for root in roots)


def tool_uses(path):
    """Liefert (cwd, Tool-Name, Input) für jeden Tool-Aufruf; die letzte Zeile je ID gewinnt."""
    calls = {}
    with open(path, encoding="utf-8") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            if record.get("type") != "assistant":
                continue
            content = (record.get("message") or {}).get("content")
            if not isinstance(content, list):
                continue
            for part in content:
                if isinstance(part, dict) and part.get("type") == "tool_use":
                    key = part.get("id") or len(calls)
                    calls[key] = (record.get("cwd") or "", part.get("name") or "", part.get("input") or {})
    return list(calls.values())


def analyse(calls):
    """Kandidaten als Liste von (Art, Zeichen, Beschreibung)."""
    findings = []
    shapes = collections.defaultdict(list)
    for cwd, name, data in calls:
        if name in SHELL_TOOLS:
            command = data.get("command") or ""
            lines = heredoc_lines(command)
            if INLINE.search(command):
                findings.append(("inline", len(command), first_line(command)))
            elif lines >= HEREDOC_MIN_LINES:
                findings.append(("heredoc", len(command), f"{lines} Zeilen: {first_line(command)}"))
            elif len(command) >= REPEAT_MIN_CHARS:
                shapes[shape(command)].append(command)
        elif name == "Write":
            file_path = data.get("file_path") or ""
            if file_path.lower().endswith(SCRIPT_SUFFIXES) and outside_repo(file_path, repo_roots(cwd)):
                findings.append(("script", len(data.get("content") or ""), file_path))
    for commands in shapes.values():
        if len(commands) >= REPEAT_MIN_COUNT:
            total = sum(len(command) for command in commands)
            findings.append(("repeat", total, f"{len(commands)}x: {first_line(commands[0])}"))
    return findings


def main():
    if len(sys.argv) != 2:
        sys.exit("Aufruf: py -I scripts/adhoc-code.py <pfad-zur-session-ohne-.jsonl>")
    root = sys.argv[1].rstrip("/").removesuffix(JSONL_SUFFIX)
    paths = [root + JSONL_SUFFIX] + sorted(glob.glob(os.path.join(root, "subagents", "*" + JSONL_SUFFIX)))
    paths = [path for path in paths if os.path.isfile(path)]
    if not paths:
        sys.exit("Keine Transkripte gefunden.")

    rows = []
    for path in paths:
        name = "main" if path == root + JSONL_SUFFIX else os.path.basename(path).removesuffix(JSONL_SUFFIX)
        rows.extend((kind, chars, name, text) for kind, chars, text in analyse(tool_uses(path)))
    if not rows:
        print("Kein Ad-hoc-Code gefunden.")
        return

    per_kind = collections.Counter()
    for kind, chars, _, _ in rows:
        per_kind[kind] += chars
    print(f"{len(rows)} Kandidaten, {sum(per_kind.values()) / 1e3:.1f}k Zeichen")
    for kind, chars in per_kind.most_common():
        print(f"  {kind:8} {chars / 1e3:7.1f}k")
    print("\nArt      Zeichen  Transkript               Beschreibung")
    for kind, chars, name, text in sorted(rows, key=lambda row: -row[1])[:MAX_ROWS]:
        print(f"{kind:8} {chars:7d}  {name[:24]:24} {text}")
    if len(rows) > MAX_ROWS:
        print(f"... {len(rows) - MAX_ROWS} weitere")


if __name__ == "__main__":
    main()

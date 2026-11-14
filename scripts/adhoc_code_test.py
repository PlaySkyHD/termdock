"""Tests für scripts/adhoc-code.py: py -I -m unittest discover -s scripts -p "*_test.py" """
import importlib.util
import json
import os
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("adhoc_code", os.path.join(os.path.dirname(__file__), "adhoc-code.py"))
adhoc = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(adhoc)

CWD = "P:\\GitHub\\termdock"


def shell(command):
    return (CWD, "Bash", {"command": command})


def write(path, content="x"):
    return (CWD, "Write", {"file_path": path, "content": content})


def kinds(calls):
    return [kind for kind, _, _ in adhoc.analyse(calls)]


class InlineTest(unittest.TestCase):
    def test_interpreter_with_inline_code(self):
        for command in ('py -I -c "print(1)"', "python - <<EOF\nx\nEOF", "node -e 'x'", "cd a && node -p 1"):
            self.assertEqual(kinds([shell(command)]), ["inline"], command)

    def test_running_a_script_file_is_not_inline(self):
        self.assertEqual(kinds([shell("py -I scripts/agent-usage.py path"), shell("node --test a.mjs")]), [])


class HeredocTest(unittest.TestCase):
    def test_long_heredoc(self):
        body = "\n".join(f"line {n}" for n in range(adhoc.HEREDOC_MIN_LINES))
        self.assertEqual(kinds([shell(f"cat > /tmp/a.md <<'EOF'\n{body}\nEOF")]), ["heredoc"])

    def test_short_heredoc_is_ignored(self):
        self.assertEqual(kinds([shell("cat > /tmp/a.md <<'EOF'\none\nEOF")]), [])

    def test_counts_only_until_the_delimiter(self):
        self.assertEqual(adhoc.heredoc_lines("cat <<EOF\na\nb\nEOF\nmore\nlines\nhere"), 2)

    def test_shift_without_delimiter_is_no_heredoc(self):
        self.assertEqual(adhoc.heredoc_lines("echo $((1 << 2))\na\nb\nc\nd\ne\nf"), 0)


class ScriptTest(unittest.TestCase):
    def test_script_outside_the_repo(self):
        self.assertEqual(kinds([write("P:\\Temp\\td-frames\\extract.cjs")]), ["script"])

    def test_files_in_repo_and_worktrees_are_ignored(self):
        calls = [
            write("P:\\GitHub\\termdock\\scripts\\new.py"),
            write("P:/GitHub/termdock-wt/feat/x/packages/core/src/a.ts"),
            write("P:\\Temp\\notes.md"),
        ]
        self.assertEqual(kinds(calls), [])

    def test_session_in_a_worktree_knows_the_main_checkout(self):
        cwd = "P:\\GitHub\\termdock-wt\\chore\\x"
        calls = [(cwd, "Write", {"file_path": "P:\\GitHub\\termdock\\scripts\\a.py", "content": ""}),
                 (cwd, "Write", {"file_path": "P:\\Temp\\a.py", "content": ""})]
        self.assertEqual(kinds(calls), ["script"])


class RepeatTest(unittest.TestCase):
    def test_same_long_command_with_other_values(self):
        template = "gh issue create --label phase-3 --title '{}' --body-file /p/Temp/issue-{}.md " + "x" * 200
        calls = [shell(template.format(f"Titel {n}", n)) for n in range(adhoc.REPEAT_MIN_COUNT)]
        found = adhoc.analyse(calls)
        self.assertEqual([kind for kind, _, _ in found], ["repeat"])
        self.assertTrue(found[0][2].startswith(f"{adhoc.REPEAT_MIN_COUNT}x: "))

    def test_short_or_rare_commands_are_ignored(self):
        calls = [shell("git status")] * 5 + [shell("gh pr view 1 " + "x" * 200)] * (adhoc.REPEAT_MIN_COUNT - 1)
        self.assertEqual(kinds(calls), [])


class TranscriptTest(unittest.TestCase):
    def test_reads_tool_uses_and_keeps_the_last_line_per_id(self):
        records = [
            {"type": "user", "message": {"content": "hi"}},
            {"type": "assistant", "cwd": CWD, "message": {"content": [
                {"type": "tool_use", "id": "a", "name": "Bash", "input": {"command": "node -"}}]}},
            {"type": "assistant", "cwd": CWD, "message": {"content": [
                {"type": "tool_use", "id": "a", "name": "Bash", "input": {"command": "node -e 1"}}]}},
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "s.jsonl")
            with open(path, "w", encoding="utf-8") as handle:
                handle.write("\n".join(json.dumps(record) for record in records) + "\nnot json\n")
            self.assertEqual(adhoc.tool_uses(path), [(CWD, "Bash", {"command": "node -e 1"})])


if __name__ == "__main__":
    unittest.main()

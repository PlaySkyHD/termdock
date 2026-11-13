// PostToolUse hook: after `gh pr create` printed a pull request URL, remind the agent to run the retro skill.
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    return;
  }
  const command = String(event?.tool_input?.command ?? "");
  if (!/gh\s+pr\s+create/.test(command)) return;
  if (!/github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(JSON.stringify(event?.tool_response ?? ""))) return;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext:
          "A pull request was just created. Run the retro skill now and file its findings as agent-retro issues before you continue or hand back to the user.",
      },
    }),
  );
});
